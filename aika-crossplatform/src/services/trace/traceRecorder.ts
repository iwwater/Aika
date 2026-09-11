import {
  redactTraceEvent, TRACE_SCHEMA_VERSION,
  type TraceEventV1, type TraceRedactionPolicy,
} from "../../domain/trace";
import type { TraceSink } from "./contracts";

/**
 * 事件源与 sink 之间的薄层。
 *
 * 它存在的理由有两个，都不是「包装一下更好看」：
 *
 * 1. **seq 必须一轮内单调递增**，而事件源分散在 Runtime、provider 适配器与两个
 *    Presenter 四处。各自计数一定撞号，所以编号权收在这里，按 turnId 各持一个。
 * 2. **脱敏只能有一处**。散在各个事件源里就等于早晚漏一处，于是 `redactTraceEvent`
 *    全仓只在这里被调用。
 *
 * 关掉时 `record` 立刻返回，连事件对象都不构造——常开的东西不能在关掉时还有成本。
 */

/** 联合类型上的 Omit 必须分发，否则七种事件会被压成一个交集，载荷字段全丢。 */
type DistributiveOmit<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never;

/** 调用方给的部分：不含 schemaVersion / turnId / seq / at，这四个由 recorder 填。 */
export type TraceEventDraft = DistributiveOmit<TraceEventV1, "schemaVersion" | "turnId" | "seq" | "at">;

export interface TraceRecorder {
  record(turnId: string, draft: TraceEventDraft): void;
  /** 这一轮结束了，扔掉它的计数器，别让长会话把 Map 堆大。 */
  endTurn(turnId: string): void;
  enabled(): boolean;
}

export interface TraceRecorderOptions {
  sink: TraceSink;
  clock?: () => number;
  /** 每次取一次，这样设置页一改就生效，不用重建 recorder。 */
  isEnabled?: () => boolean;
  policy?: () => TraceRedactionPolicy;
}

export function createTraceRecorder(options: TraceRecorderOptions): TraceRecorder {
  const clock = options.clock ?? (() => Date.now());
  const isEnabled = options.isEnabled ?? (() => true);
  const policy = options.policy ?? (() => ({ includeText: false }));
  const counters = new Map<string, number>();

  return {
    record(turnId, draft) {
      if (!isEnabled()) return;
      try {
        const seq = (counters.get(turnId) ?? 0) + 1;
        counters.set(turnId, seq);
        const event = {
          ...draft,
          schemaVersion: TRACE_SCHEMA_VERSION,
          turnId,
          seq,
          at: clock(),
        } as TraceEventV1;
        options.sink.append(redactTraceEvent(event, policy()));
      } catch {
        // Trace 是旁路：sink 自己该 fail-open，这里再兜一层，
        // 保证任何实现的意外都不会顺着调用栈回到对话链路里。
      }
    },
    endTurn(turnId) {
      counters.delete(turnId);
    },
    enabled: isEnabled,
  };
}

/** 没装 Trace 能力时用它：所有调用都是空操作，调用方不需要写 `?.`。 */
export const NO_TRACE: TraceRecorder = {
  record: () => undefined,
  endTurn: () => undefined,
  enabled: () => false,
};
