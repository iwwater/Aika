import type { Clock } from "../time/tokens";
import { skipped, type PetEvent, type PetResult } from "./contracts";
import type { PetCommandKind } from "./eventMapping";

/**
 * 有界串行发送器（PET-04）。
 *
 * 这不是动画排程器，也不是 BehaviorFSM：它只保证**最多 1 个在途 + 16 个待发**，
 * 并在同轮内做状态合并。桌宠必须服从对话节奏，而不是反过来堆积滞后指令。
 *
 * 规则全部来自契约 §4：
 * - 同轮中间态合并为最新一个；
 * - 同轮终态到达时清掉该轮待发的中间态；
 * - 队列满先丢最旧的**中间态**，没有中间态可丢就拒新命令（`overloaded`）；
 * - 最近 128 个逻辑键去重，最长保留 60 秒（同一轮最终文本只发一次）；
 * - 每次发送前复核 enabled、generation、期限。
 *
 * 去重键由上层给（`dedupeKey`），因为它知道「哪两件事其实是同一件事」；
 * 线上的 `commandId` 仍由 Service 分配，两者不是一回事。
 */

export const PET_BUFFER_CAPACITY = 16;
export const PET_DEDUPE_LIMIT = 128;
export const PET_DEDUPE_TTL_MS = 60_000;

export interface PetQueuedCommand {
  /** 逻辑去重键：同一轮同一语义必须是同一个键。 */
  dedupeKey: string;
  kind: PetCommandKind;
  /** 中间态可被同轮更晚的中间态替换。 */
  intermediate: boolean;
  runtimeTurnId?: string;
  expiresAt: number;
  /** 入队时的 Service 代次；发送前必须仍然相等。 */
  generation: number;
  text?: string;
  name?: string;
  event?: PetEvent;
  message?: string;
}

export interface PetCommandBufferDeps {
  clock: Clock;
  send: (command: PetQueuedCommand) => Promise<PetResult>;
  currentGeneration: () => number;
  isEnabled: () => boolean;
  capacity?: number;
  dedupeLimit?: number;
  dedupeTtlMs?: number;
}

export interface PetCommandBufferDiagnostics {
  sent: number;
  /** 同轮中间态被更新值替换的次数。 */
  merged: number;
  /** 同轮终态清理掉的中间态数量。 */
  cleaned: number;
  deduped: number;
  expired: number;
  stale: number;
  /** 队列满时被丢弃的中间态数量。 */
  dropped: number;
  /** 队列满且没有中间态可丢时的拒绝次数。 */
  rejected: number;
}

export interface PetCommandBuffer {
  /** 同步返回：`accepted` 只表示**已入队**，不代表已发送或已播放。 */
  enqueue(command: PetQueuedCommand): PetResult;
  /** 该轮终态到达：清掉同轮待发的中间态（终态本身就是最新状态）。 */
  completeTurn(runtimeTurnId: string): void;
  /** 取消/换轮：清掉该轮全部待发任务。在途的那一个无法可靠撤回。 */
  cancelTurn(runtimeTurnId: string): void;
  cancelAll(): void;
  pendingCount(): number;
  inFlightCount(): number;
  /** 只给测试与诊断用；生产路径不需要等它。 */
  whenIdle(): Promise<void>;
  diagnostics(): PetCommandBufferDiagnostics;
}

export function createPetCommandBuffer(deps: PetCommandBufferDeps): PetCommandBuffer {
  const capacity = Math.max(1, deps.capacity ?? PET_BUFFER_CAPACITY);
  const dedupeLimit = Math.max(1, deps.dedupeLimit ?? PET_DEDUPE_LIMIT);
  const dedupeTtlMs = deps.dedupeTtlMs ?? PET_DEDUPE_TTL_MS;

  const pending: PetQueuedCommand[] = [];
  const seen = new Map<string, number>();
  let running = false;
  let inFlight: PetQueuedCommand | null = null;
  let idleWaiters: Array<() => void> = [];
  const diagnostics: PetCommandBufferDiagnostics = {
    sent: 0, merged: 0, cleaned: 0, deduped: 0, expired: 0, stale: 0, dropped: 0, rejected: 0,
  };

  function pruneDedupe(): void {
    const now = deps.clock.now();
    for (const [key, expiresAt] of [...seen]) {
      if (expiresAt <= now) seen.delete(key);
    }
    // 上限是硬的：即使都在 TTL 内也只留最近的 N 个。
    while (seen.size > dedupeLimit) {
      const oldest = seen.keys().next();
      if (oldest.done) break;
      seen.delete(oldest.value);
    }
  }

  function settleIdle(): void {
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const waiter of waiters) waiter();
  }

  async function pump(): Promise<void> {
    if (running) return;
    running = true;
    try {
      for (;;) {
        const command = pending.shift();
        if (!command) break;
        if (!deps.isEnabled() || command.generation !== deps.currentGeneration()) {
          diagnostics.stale += 1;
          continue;
        }
        if (command.expiresAt <= deps.clock.now()) {
          diagnostics.expired += 1;
          continue;
        }
        inFlight = command;
        try {
          await deps.send(command);
        } catch {
          // 发送失败已经是结果语义的一部分；这里只保证循环不中断。
        } finally {
          inFlight = null;
        }
        diagnostics.sent += 1;
      }
    } finally {
      running = false;
      settleIdle();
      // 排空期间新到的任务：再泵一次，而不是把它们留到下一次 enqueue。
      if (pending.length) void pump();
    }
  }

  return {
    enqueue(command: PetQueuedCommand): PetResult {
      pruneDedupe();
      if (seen.has(command.dedupeKey)) {
        diagnostics.deduped += 1;
        // 重复的同一件事：不写代码是因为「重复」本来就不是失败原因，
        // 诊断计数才是它该待的地方。
        return { outcome: "skipped" };
      }
      seen.set(command.dedupeKey, deps.clock.now() + dedupeTtlMs);

      // 同轮中间态合并：就地替换，保持它与其它命令的相对顺序。
      if (command.intermediate && command.runtimeTurnId !== undefined) {
        const index = pending.findIndex(
          (item) => item.intermediate && item.runtimeTurnId === command.runtimeTurnId,
        );
        if (index >= 0) {
          pending[index] = command;
          diagnostics.merged += 1;
          void pump();
          return { outcome: "accepted" };
        }
      }

      if (pending.length >= capacity) {
        const oldest = pending.findIndex((item) => item.intermediate);
        if (oldest >= 0) {
          pending.splice(oldest, 1);
          diagnostics.dropped += 1;
        } else {
          diagnostics.rejected += 1;
          return skipped("overloaded");
        }
      }

      pending.push(command);
      void pump();
      return { outcome: "accepted" };
    },

    completeTurn(runtimeTurnId: string): void {
      for (let index = pending.length - 1; index >= 0; index -= 1) {
        const item = pending[index]!;
        if (item.intermediate && item.runtimeTurnId === runtimeTurnId) {
          pending.splice(index, 1);
          diagnostics.cleaned += 1;
        }
      }
    },

    cancelTurn(runtimeTurnId: string): void {
      for (let index = pending.length - 1; index >= 0; index -= 1) {
        if (pending[index]!.runtimeTurnId === runtimeTurnId) {
          pending.splice(index, 1);
          diagnostics.stale += 1;
        }
      }
      // 在途的那个不从这里撤：它可能已经到上游了，谎称撤回了比不撤更糟。
    },

    cancelAll(): void {
      diagnostics.stale += pending.length;
      pending.length = 0;
      settleIdle();
    },

    pendingCount(): number {
      return pending.length;
    },

    inFlightCount(): number {
      return inFlight ? 1 : 0;
    },

    whenIdle(): Promise<void> {
      if (!running && pending.length === 0) return Promise.resolve();
      return new Promise((resolve) => {
        idleWaiters.push(resolve);
      });
    },

    diagnostics(): PetCommandBufferDiagnostics {
      return { ...diagnostics };
    },
  };
}
