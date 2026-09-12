import {
  resolveUsageCoverage,
  type RequestUsageSample, type UsageAttemptStatus, type UsageRecordV1,
} from "../../domain/usageLedger";
import type { ProviderUsage } from "../../domain/providers";
import type {
  UsageLedgerRecorder, UsageLedgerStore, UsageObserveInput, UsageRecorderDiagnostics, UsageRequestOptions,
} from "./contracts";

/**
 * 用量台账的采集侧（LLM-12）。
 *
 * 它挂在 providerClient 的物理请求边界上：每次真实网络尝试，providerClient 发
 * started 与终态样本，这里拼成 UsageRecordV1 幂等写进台账。三条硬规矩：
 *
 * 1. **绝不挡原请求**。写失败旁路化（计数、不重试），待写队列有界（满了丢最旧的、
 *    计数），observe 本身没有任何 await。
 * 2. **采集开关与 Trace 同源**。开关关着时一个记录都不新写；已登记的尝试照常
 *    等终态写完，不留半条 unfinished。
 * 3. **不猜**。purpose 用调用方声明的；token 用平台报的；没报就是 unknown，
 *    不拿 0 或估算值补位。
 */

/** 待写队列上限：慢存储时先丢最旧的记录，也不能让内存涨上天。 */
export const USAGE_WRITE_QUEUE_LIMIT = 64;

export interface UsageRecorderOptions {
  store: UsageLedgerStore;
  /** 采集开关（与 Trace enabled 同源）。关闭时不新写记录。 */
  isEnabled?: () => boolean;
  /** 当前主体。不提供则记录无 scope，查询时归入 legacy 分组。 */
  scope?: () => string | undefined;
  clock?: () => number;
  idFactory?: () => string;
  queueLimit?: number;
}

export function createUsageLedgerRecorder(options: UsageRecorderOptions): UsageLedgerRecorder {
  const store = options.store;
  const isEnabled = options.isEnabled ?? (() => true);
  const scopeOf = options.scope ?? (() => undefined);
  const clock = options.clock ?? (() => Date.now());
  const idFactory = options.idFactory ?? defaultIdFactory;
  const queueLimit = Math.max(1, options.queueLimit ?? USAGE_WRITE_QUEUE_LIMIT);

  const diagnostics: UsageRecorderDiagnostics = { registered: 0, writeFailures: 0, dropped: 0 };

  // 待写队列：串行落盘，失败吞掉计数；满了丢最旧的——台账少一条比进程爆一条强。
  const pending: UsageRecordV1[] = [];
  let draining = false;
  function enqueueWrite(record: UsageRecordV1): void {
    if (pending.length >= queueLimit) {
      pending.shift();
      diagnostics.dropped += 1;
    }
    pending.push(record);
    void drain();
  }
  async function drain(): Promise<void> {
    if (draining) return;
    draining = true;
    try {
      while (pending.length) {
        const record = pending.shift() as UsageRecordV1;
        try {
          await store.upsert(record);
        } catch {
          // 旁路化：台账写不进去不能连累对话，也不能无限重试把它变成新的故障源。
          diagnostics.writeFailures += 1;
        }
      }
    } finally {
      draining = false;
    }
  }

  function captureEnabled(): boolean {
    try {
      return isEnabled();
    } catch {
      // 开关本身炸了按关处理：默认不留痕比默认留痕安全。
      return false;
    }
  }

  function baseRecord(
    input: UsageObserveInput,
    logicalRequestId: string,
    startedAt: number,
  ): UsageRecordV1 {
    const scope = scopeOf();
    return {
      schemaVersion: 1,
      id: idFactory(),
      logicalRequestId,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      ...(scope ? { scope } : {}),
      purpose: input.purpose,
      providerId: input.config.id,
      protocol: input.config.protocol,
      model: input.config.model,
      startedAt,
      status: "unfinished",
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      coverage: "unknown",
    };
  }

  function finishAttempt(record: UsageRecordV1, sample: RequestUsageSample, endedAt = clock()): void {
    record.status = sample.phase as UsageAttemptStatus;
    record.endedAt = endedAt;
    const usage: ProviderUsage | undefined = sample.usage;
    if (usage) {
      record.promptTokens = usage.promptTokens;
      record.completionTokens = usage.completionTokens;
      record.totalTokens = usage.totalTokens;
      record.coverage = resolveUsageCoverage(usage);
    }
    enqueueWrite(record);
  }

  return {
    observe<T extends UsageRequestOptions = UsageRequestOptions>(input: UsageObserveInput<T>): T {
      // 每个逻辑请求一套 in-flight 与开关状态：并发请求互不串扰，attempt 号只在
      // 本请求内有意义。
      const inFlight = new Map<number, UsageRecordV1>();
      let uncaptured = false;

      const wrapped = { ...(input.options ?? {}) } as T;
      wrapped.onRequestUsage = (sample: RequestUsageSample) => {
        if (sample.phase === "started") {
          if (uncaptured) return;
          if (!captureEnabled()) {
            // 这个逻辑请求开始时采集就是关的：整条请求都保持沉默，不只记后半截。
            uncaptured = true;
            return;
          }
          const record = baseRecord(input, sample.logicalRequestId, clock());
          inFlight.set(sample.attempt, record);
          diagnostics.registered += 1;
          enqueueWrite(record);
          return;
        }

        // 终态：开始时登记过就照常写完（开关半途关掉不留半条）；
        // 没登记过且全程没采集过就保持沉默。
        const existing = inFlight.get(sample.attempt);
        if (!existing) {
          if (uncaptured || !captureEnabled()) return;
          // 有终态没开始：进程内不该发生；真发生了就按此刻补登记，
          // 「开始时间未知」由 startedAt==endedAt 承载。
          const moment = clock();
          const record = baseRecord(input, sample.logicalRequestId, moment);
          diagnostics.registered += 1;
          finishAttempt(record, sample, moment);
          return;
        }
        inFlight.delete(sample.attempt);
        finishAttempt(existing, sample);
      };

      // purpose 是调用方声明的；「unknown」不显式设置，让 providerClient 的
      // 未声明默认值走同一个语义，两条链路不会各说各话。
      if (input.purpose !== "unknown") wrapped.requestPurpose = input.purpose;
      if (input.turnId) wrapped.requestTurnId = input.turnId;
      return wrapped;
    },

    diagnostics: () => ({ ...diagnostics }),
  };
}

function defaultIdFactory(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `usage-${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`;
}
