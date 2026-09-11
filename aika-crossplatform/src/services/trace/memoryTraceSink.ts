import { sortTraceEvents, type TraceEventV1, type TraceQuery } from "../../domain/trace";
import type { TraceSink } from "./contracts";

/**
 * 内存环形缓冲。
 *
 * 工作台要实时看最近发生了什么，落盘那一份查起来太慢也太啰嗦；而且开发构建下
 * Trace 常开，无上限的数组迟早把内存吃掉——所以是**环形**：满了就丢最旧的，
 * 不是丢最新的。丢弃是预期行为，不是错误。
 */
export function createMemoryTraceSink(capacity = 500): TraceSink & { size(): number; dropped(): number } {
  const limit = Math.max(1, capacity);
  const buffer: TraceEventV1[] = [];
  let dropped = 0;

  function matches(event: TraceEventV1, filter: TraceQuery): boolean {
    if (filter.turnId && event.turnId !== filter.turnId) return false;
    if (filter.kind && event.kind !== filter.kind) return false;
    if (filter.since !== undefined && event.at < filter.since) return false;
    return true;
  }

  return {
    append(event) {
      // fail-open：环形缓冲几乎不可能失败，但这里的契约就是「永不抛」。
      try {
        buffer.push(event);
        while (buffer.length > limit) {
          buffer.shift();
          dropped += 1;
        }
      } catch {
        // 咽掉：一条 trace 不值得毁掉一轮对话。
      }
    },
    async tail(count = 50) {
      return sortTraceEvents(buffer).slice(-Math.max(0, count)).reverse();
    },
    async query(filter) {
      const hit = sortTraceEvents(buffer.filter((event) => matches(event, filter)));
      return filter.limit === undefined ? hit : hit.slice(0, Math.max(0, filter.limit));
    },
    async flush() {
      // 内存实现没有排队。
    },
    size: () => buffer.length,
    dropped: () => dropped,
  };
}
