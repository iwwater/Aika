/**
 * 后台记忆维护队列（LLM-04：唯一 worker）。
 *
 * 抽取与落库不该挡在回复前面：候选在这里排队，由一个后台 worker 在
 * 「每 8 个成功轮 / sessionEnd 显式触发」时批量写入。但「异步」不等于
 * 「可以悄悄丢」——批次带候选快照与来源消息 id，写入失败按指数退避重试
 * （初值 1 秒、上限 30 秒、至多 3 次），之后标 failed 等显式重试。
 *
 * 幂等靠三层：批次 ID 由有序来源消息集合 + 策略版本决定（同来源不会生成
 * 第二批）；已写完批次的 ID 留在近期完成集合里（重复投递不再执行）；
 * repository.upsert 本身按内容指纹去重并尊重抑制标记（重放不会让删掉的
 * 记忆复活、不会堆出重复条目）。
 *
 * 关闭维护递增写入 epoch：worker 在每次真实提交前后核对 epoch，关掉之后
 * 旧批次一律作废，重新开启也不会复活它们。持久化走可注入的 journal 端口
 * （生产用存储 KV 单记录原子替换；SQLite 事务语义归存储层），重启后
 * running 批次回到 pending 继续跑。
 */

import {
  createMemoryV2,
  memoryTypeFromCategory,
  type MemoryCandidate,
  type MemoryRecordV2,
} from "../../domain/memory";
import type { MemoryRepository } from "./memoryRepository";

export type MaintenanceFlushReason = "turnThreshold" | "sessionEnd" | "idle";

export interface MaintenanceBatch {
  /** 有序来源消息集合 + 策略版本决定的稳定 ID；同来源重复投递不会生成第二批。 */
  id: string;
  sourceTurnIds: string[];
  sourceMessageIds: string[];
  /** 候选快照：重启后靠它复原写入，不能只存 ID 假定消息还在。 */
  candidates: readonly MemoryCandidate[];
  status: "pending" | "running" | "done" | "failed";
  attempts: number;
  /** 下次自动重试不早于这个时刻（指数退避）；显式 flush 不受它限制。 */
  nextAttemptAt: number;
}

export interface MaintenanceJournalState {
  epoch: number;
  batches: MaintenanceBatch[];
}

export interface MaintenanceJournal {
  load(): Promise<MaintenanceJournalState | null>;
  save(state: MaintenanceJournalState): Promise<void>;
}

export interface MaintenanceFlushResult {
  attempted: number;
  written: number;
  failed: number;
  errors: string[];
}

export interface MaintenanceEnqueueInput {
  turnId: string;
  sourceMessageIds: readonly string[];
  candidates: readonly MemoryCandidate[];
}

export interface MemoryMaintenanceOptions {
  repository: MemoryRepository;
  journal?: MaintenanceJournal;
  /** 抽取口径升级时递增：旧来源集合生成新批次 ID，不与旧策略混批。 */
  policyVersion?: string;
  /** 每 N 个成功轮触发一次后台批次。 */
  turnThreshold?: number;
  maxAttempts?: number;
  backoffBaseMs?: number;
  backoffCapMs?: number;
  /** 待处理批次总量上限：超出拒收并可见报错，不无限积压。 */
  maxPendingBatches?: number;
  /** 单批候选上限：超出拆成同源的下一批，不静默丢内容。 */
  maxBatchCandidates?: number;
  now?: () => number;
  /** 调度器注入：测试用假时钟驱动退避，不必真等 30 秒。返回取消函数。 */
  schedule?: (fn: () => void, ms: number) => () => void;
  onError?: (error: unknown) => void;
}

export interface MemoryMaintenance {
  /** 记一次成功轮：只有它推进阈值；没有候选的轮同样算数。 */
  noteTurn(turnId: string): void;
  enqueue(input: MaintenanceEnqueueInput): void;
  flush(reason: MaintenanceFlushReason): Promise<MaintenanceFlushResult>;
  setEnabled(enabled: boolean): void;
  dispose(): void;
  /** 从日志恢复：running 批次回 pending。幂等；不等待它完成也能安全入队。 */
  restore(): Promise<void>;
  pending(): number;
  /** 诊断快照：pending/running/failed 批次（done 不保留）。 */
  snapshot(): MaintenanceBatch[];
}

const EMPTY_RESULT: MaintenanceFlushResult = { attempted: 0, written: 0, failed: 0, errors: [] };
/** 最近完成批次 ID 的记忆上限：防重复投递的集合不无限增长。 */
const RECENT_DONE_LIMIT = 500;

function hashIds(ids: readonly string[]): string {
  let hash = 5381;
  for (const id of ids) {
    for (let index = 0; index < id.length; index += 1) {
      hash = ((hash << 5) + hash + id.charCodeAt(index)) | 0;
    }
  }
  return (hash >>> 0).toString(16);
}

export function createMemoryMaintenance(options: MemoryMaintenanceOptions): MemoryMaintenance {
  const repository = options.repository;
  const policyVersion = options.policyVersion ?? "v1";
  const turnThreshold = options.turnThreshold ?? 8;
  const maxAttempts = options.maxAttempts ?? 3;
  const backoffBaseMs = options.backoffBaseMs ?? 1_000;
  const backoffCapMs = options.backoffCapMs ?? 30_000;
  const maxPendingBatches = options.maxPendingBatches ?? 500;
  const maxBatchCandidates = options.maxBatchCandidates ?? 64;
  const now = options.now ?? Date.now;
  const schedule = options.schedule
    ?? ((fn: () => void, ms: number) => {
      const handle = setTimeout(fn, ms);
      return () => clearTimeout(handle);
    });

  let enabled = true;
  let disposed = false;
  let epoch = 0;
  let turnCounter = 0;
  let restoreStarted = false;

  const batches = new Map<string, MaintenanceBatch>();
  const recentDoneIds = new Set<string>();
  const recentDoneOrder: string[] = [];

  let cancelTimer: (() => void) | null = null;
  let workerChain: Promise<unknown> = Promise.resolve();

  function reportError(error: unknown): void {
    options.onError?.(error);
  }

  function persist(): void {
    if (!options.journal || disposed) return;
    const state: MaintenanceJournalState = {
      epoch,
      batches: [...batches.values()],
    };
    options.journal.save(state).catch((error) => {
      // 日志写失败不阻断维护（内存态仍在），但必须能被看见。
      reportError(error instanceof Error ? error : new Error(String(error)));
    });
  }

  function rememberDone(id: string): void {
    recentDoneIds.add(id);
    recentDoneOrder.push(id);
    while (recentDoneOrder.length > RECENT_DONE_LIMIT) {
      const oldest = recentDoneOrder.shift();
      if (oldest) recentDoneIds.delete(oldest);
    }
  }

  function cancelScheduled(): void {
    cancelTimer?.();
    cancelTimer = null;
  }

  function scheduleRun(delayMs: number): void {
    if (disposed || !enabled) return;
    cancelScheduled();
    cancelTimer = schedule(() => {
      cancelTimer = null;
      void enqueueRun(false);
    }, delayMs);
  }

  function backoffDelayMs(batch: MaintenanceBatch): number {
    return Math.min(backoffBaseMs * 2 ** Math.max(0, batch.attempts - 1), backoffCapMs);
  }

  function buildRecords(batch: MaintenanceBatch): MemoryRecordV2[] {
    const records: MemoryRecordV2[] = [];
    const stamped = now();
    for (const candidate of batch.candidates) {
      const record = createMemoryV2({
        content: candidate.content,
        type: memoryTypeFromCategory(candidate.category),
        sourceMessageIds: batch.sourceMessageIds,
        sourceKind: "messages",
        status: "candidate",
        now: stamped,
      });
      // 畸形候选（空正文等）在这里被过滤，而不是让整批失败。
      if (record) records.push(record);
    }
    return records;
  }

  function dropBatch(batch: MaintenanceBatch): void {
    batches.delete(batch.id);
  }

  async function runDue(force: boolean): Promise<MaintenanceFlushResult> {
    const result: MaintenanceFlushResult = { attempted: 0, written: 0, failed: 0, errors: [] };
    for (const batch of [...batches.values()]) {
      if (disposed || !enabled) break;
      if (batch.status === "failed" && !force) continue;
      if (batch.status === "pending" && !force && batch.nextAttemptAt > now()) continue;

      // 提交边界前递增计数并核对 epoch：关闭/释放之后不再发起新的写入。
      batch.status = "running";
      batch.attempts += 1;
      result.attempted += 1;
      if (disposed || !enabled) {
        batch.status = "pending";
        break;
      }

      const records = buildRecords(batch);
      try {
        if (records.length) {
          await repository.upsert(records);
          result.written += records.length;
        }
        // 提交后再核对：等待期间被关闭（epoch 变化）说明这批属于旧策略，
        // 已写入的留在存储里（不回滚），但不再标记完成、也不再重试。
        if (disposed || !enabled) {
          dropBatch(batch);
          persist();
          break;
        }
        batch.status = "done";
        rememberDone(batch.id);
        dropBatch(batch);
        persist();
      } catch (error) {
        if (disposed || !enabled) {
          batch.status = "pending";
          break;
        }
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(message);
        if (batch.attempts < maxAttempts) {
          batch.status = "pending";
          // 同一批立刻再试通常还是失败：指数退避，调度器到点再接手。
          batch.nextAttemptAt = now() + backoffDelayMs(batch);
          persist();
          scheduleRun(backoffDelayMs(batch));
          break;
        }
        batch.status = "failed";
        result.failed += 1;
        reportError(error);
        persist();
      }
    }
    return result;
  }

  /** 单 worker：任何触发都汇入同一条执行链，绝不开第二个并发写。 */
  function enqueueRun(force: boolean): Promise<MaintenanceFlushResult> {
    const run = workerChain.then(() => runDue(force));
    workerChain = run.then(() => undefined, () => undefined);
    return run;
  }

  function makeBatchId(sourceMessageIds: readonly string[], chunk = 0): string {
    const base = `${policyVersion}-${hashIds(sourceMessageIds)}`;
    return chunk === 0 ? base : `${base}#${chunk}`;
  }

  function enqueue(input: MaintenanceEnqueueInput): void {
    if (disposed || !enabled) return;
    const usable = input.candidates.filter(
      (candidate) => typeof candidate?.content === "string" && candidate.content.trim(),
    );
    if (!usable.length) return;
    if (batches.size >= maxPendingBatches) {
      reportError(new Error(`后台维护队列已满（${maxPendingBatches} 批），本轮候选被拒收`));
      return;
    }
    const sourceMessageIds = [...new Set(input.sourceMessageIds.filter(Boolean))];
    const sourceTurnIds = input.turnId ? [input.turnId] : [];
    const chunks = Math.ceil(usable.length / maxBatchCandidates);
    for (let chunk = 0; chunk < chunks; chunk += 1) {
      const id = makeBatchId(sourceMessageIds, chunk);
      if (batches.has(id) || recentDoneIds.has(id)) continue;
      batches.set(id, {
        id,
        sourceTurnIds,
        sourceMessageIds,
        candidates: usable.slice(chunk * maxBatchCandidates, (chunk + 1) * maxBatchCandidates),
        status: "pending",
        attempts: 0,
        nextAttemptAt: 0,
      });
    }
    persist();
  }

  return {
    noteTurn(turnId: string): void {
      void turnId;
      if (disposed || !enabled) return;
      turnCounter += 1;
      if (turnCounter >= turnThreshold) {
        turnCounter = 0;
        // 阈值触发是后台行为：不等待、不阻塞调用方。
        void enqueueRun(true).catch(reportError);
      }
    },

    enqueue(input: MaintenanceEnqueueInput): void {
      enqueue(input);
    },

    async flush(reason: MaintenanceFlushReason): Promise<MaintenanceFlushResult> {
      void reason;
      if (disposed || !enabled) return EMPTY_RESULT;
      // 显式触发重置失败批次的连败计数：调用方明确要求再试一次。
      for (const batch of batches.values()) {
        if (batch.status === "failed") {
          batch.status = "pending";
          batch.attempts = 0;
          batch.nextAttemptAt = 0;
        }
      }
      return enqueueRun(true);
    },

    setEnabled(next: boolean): void {
      if (disposed || enabled === next) return;
      enabled = next;
      turnCounter = 0;
      if (!next) {
        // 递增 epoch 让在途/待处理的旧批次全部作废；重新开启不复活它们。
        epoch += 1;
        for (const batch of [...batches.values()]) dropBatch(batch);
        cancelScheduled();
        persist();
      }
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      epoch += 1;
      cancelScheduled();
      for (const batch of [...batches.values()]) dropBatch(batch);
      persist();
    },

    async restore(): Promise<void> {
      if (restoreStarted || disposed || !options.journal) return;
      restoreStarted = true;
      let state: MaintenanceJournalState | null = null;
      try {
        state = await options.journal.load();
      } catch (error) {
        reportError(error);
      }
      if (disposed || !state) return;
      epoch = Math.max(epoch, state.epoch ?? 0);
      for (const batch of state.batches ?? []) {
        if (!batch?.id || batches.has(batch.id) || recentDoneIds.has(batch.id)) continue;
        // 上个进程没跑完的批次（running）回到 pending：重启即恢复。
        batches.set(batch.id, {
          ...batch,
          status: batch.status === "running" || batch.status === "pending" ? "pending" : batch.status,
        });
      }
      persist();
      if (batches.size) scheduleRun(0);
    },

    pending(): number {
      return batches.size;
    },

    snapshot(): MaintenanceBatch[] {
      return [...batches.values()].map((batch) => ({ ...batch }));
    },
  };
}
