import type { Clock } from "../time/tokens";

/**
 * 统一 capture/OCR 调度器（FE-32）。
 *
 * FE-21 的词表轨与 FE-32 的全文读屏共用**同一个**调度器实例：并发 1、pending 1、
 * 滚动每分钟最多 10 次，手动请求也计入同一份总额——不另开第二个 worker，也不
 * 让「用户点一下」变成绕过限流的后门。
 *
 * 优先级只有两档：
 * - `manual`（用户点击「看屏幕聊聊」）可以**替换还没开始**的 auto 候选；
 * - `auto` 永远不会顶掉 manual；同档后到者顶掉先到者（最新候选胜）。
 *
 * 被顶掉的候选得到 `superseded`，达到额度得到 `rate_limited` 并附下一次可用时间——
 * 静默挂起与偷偷突破上限都不允许，调用方据此显示状态。
 */

export const OCR_QUOTA_PER_MINUTE = 10;
export const QUOTA_WINDOW_MS = 60_000;

export type SchedulerPriority = "auto" | "manual";

export type SchedulerOutcome<T> =
  | { status: "done"; value: T }
  | { status: "failed"; error: unknown }
  /** 达到滚动额度：retryAtMonotonicMs 是最早可再次提交的单调时刻。 */
  | { status: "rate_limited"; retryAtMonotonicMs: number }
  /** 被同档后到者或 manual 顶掉（还没开始执行）。 */
  | { status: "superseded" }
  /** 调用方 signal abort 或调度器被 cancelAll/dispose。 */
  | { status: "cancelled" };

export interface SchedulerQuota {
  used: number;
  limit: number;
  /** 额度未满为 null；已满时是最早可用的单调时刻。 */
  retryAtMonotonicMs: number | null;
}

export interface CaptureScheduler {
  /**
   * 提交一次采集/识别任务。任务只有真正开始执行时才计入额度——
   * 被顶掉或取消的候选不消耗配额。
   */
  submit<T>(
    task: (signal: AbortSignal) => Promise<T>,
    options: { priority: SchedulerPriority; signal?: AbortSignal },
  ): Promise<SchedulerOutcome<T>>;
  quota(): SchedulerQuota;
  /** 撤销未开始的候选并 abort 运行中的任务（暂停/结束/停止全部感知）。 */
  cancelAll(): void;
  pending(): SchedulerPriority | null;
  running(): boolean;
}

export interface CaptureSchedulerOptions {
  clock: Clock;
  maxPerMinute?: number;
  windowMs?: number;
}

interface PendingEntry {
  priority: SchedulerPriority;
  start: () => void;
  settle: (outcome: SchedulerOutcome<never>) => void;
}

export function createCaptureScheduler(options: CaptureSchedulerOptions): CaptureScheduler {
  const limit = options.maxPerMinute ?? OCR_QUOTA_PER_MINUTE;
  const windowMs = options.windowMs ?? QUOTA_WINDOW_MS;
  const runs: number[] = [];
  let pendingEntry: PendingEntry | null = null;
  let isRunning = false;
  /** 运行中任务的控制器：cancelAll 要能真的中止在途识别，而不是只清队列。 */
  let runningController: AbortController | null = null;

  /** 滚动窗口裁剪；只读，不消耗额度。 */
  function trim(now: number): void {
    while (runs.length > 0 && now - runs[0] >= windowMs) runs.shift();
  }

  function quota(): SchedulerQuota {
    const now = options.clock.now();
    trim(now);
    if (runs.length < limit) return { used: runs.length, limit, retryAtMonotonicMs: null };
    return { used: runs.length, limit, retryAtMonotonicMs: runs[0] + windowMs };
  }

  function drain(): void {
    if (isRunning || !pendingEntry) return;
    const entry = pendingEntry;
    pendingEntry = null;
    entry.start();
  }

  return {
    submit<T>(
      task: (signal: AbortSignal) => Promise<T>,
      opts: { priority: SchedulerPriority; signal?: AbortSignal },
    ): Promise<SchedulerOutcome<T>> {
      return new Promise<SchedulerOutcome<T>>((resolve) => {
        if (opts.signal?.aborted) {
          resolve({ status: "cancelled" });
          return;
        }
        // 占槽规则：manual 顶掉未开始的 auto；同档最新者胜；auto 顶不掉 manual。
        if (pendingEntry) {
          if (pendingEntry.priority === "manual" && opts.priority === "auto") {
            resolve({ status: "superseded" });
            return;
          }
          const displaced = pendingEntry;
          pendingEntry = null;
          displaced.settle({ status: "superseded" });
        }

        const controller = new AbortController();
        let settled = false;
        const finish = (outcome: SchedulerOutcome<T>): void => {
          if (settled) return;
          settled = true;
          opts.signal?.removeEventListener("abort", onAbort);
          resolve(outcome);
        };
        function onAbort(): void {
          controller.abort();
          // 还在排队时直接取消；已开始的由任务自己观察 signal 结束。
          if (pendingEntry === entry) {
            pendingEntry = null;
            finish({ status: "cancelled" });
          }
        }
        opts.signal?.addEventListener("abort", onAbort, { once: true });

        const entry: PendingEntry = {
          priority: opts.priority,
          settle: (outcome) => finish(outcome as SchedulerOutcome<T>),
          start: () => {
            const now = options.clock.now();
            trim(now);
            if (runs.length >= limit) {
              // 额度用尽：明确告知下一次可用时间，不静默挂起。
              finish({ status: "rate_limited", retryAtMonotonicMs: runs[0] + windowMs });
              queueMicrotask(drain);
              return;
            }
            if (opts.signal?.aborted) {
              finish({ status: "cancelled" });
              queueMicrotask(drain);
              return;
            }
            runs.push(now);
            isRunning = true;
            runningController = controller;
            void (async () => {
              try {
                const value = await task(controller.signal);
                finish(controller.signal.aborted ? { status: "cancelled" } : { status: "done", value });
              } catch (error) {
                finish(controller.signal.aborted ? { status: "cancelled" } : { status: "failed", error });
              } finally {
                isRunning = false;
                if (runningController === controller) runningController = null;
                drain();
              }
            })();
          },
        };

        pendingEntry = entry;
        drain();
      });
    },

    quota,

    cancelAll(): void {
      const entry = pendingEntry;
      pendingEntry = null;
      entry?.settle({ status: "cancelled" });
      // 在途任务一并中止：迟到的识别结果按 cancelled 收口，不会外发。
      runningController?.abort();
    },

    pending(): SchedulerPriority | null {
      return pendingEntry?.priority ?? null;
    },

    running(): boolean {
      return isRunning;
    },
  };
}
