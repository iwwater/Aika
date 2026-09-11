import type { TraceEventV1, TraceQuery } from "../../domain/trace";

/**
 * Trace 落地端口。
 *
 * `append` **永不抛、永不返回 Promise**：Trace 是旁路，主链路不等它、不被它拖住。
 * 任何一个 sink 出问题都不允许影响一轮对话（fail-open），这条是硬要求而不是建议。
 */
export interface TraceSink {
  append(event: TraceEventV1): void;
  /** 最近若干条，时间倒序（同轮内按 seq 倒序）。 */
  tail(limit?: number): Promise<readonly TraceEventV1[]>;
  query(filter: TraceQuery): Promise<readonly TraceEventV1[]>;
  /** 把排队中的写入落完。只给测试与「查询前先对齐」用，业务链路不调用。 */
  flush(): Promise<void>;
}
