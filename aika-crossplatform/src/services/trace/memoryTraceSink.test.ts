import { describe, expect, it } from "vitest";
import { createMemoryTraceSink } from "./memoryTraceSink";
import { traceEvent, TRACE_BASE_AT } from "./trace.conformance";

/**
 * 环形缓冲自己的一件事：满了丢最旧的。
 * 契约层面的行为在 trace.conformance 里，与落盘实现共用。
 */
describe("memoryTraceSink 环形缓冲", () => {
  it("满了丢最旧的，不是丢最新的，也不是无限长", async () => {
    const sink = createMemoryTraceSink(3);
    for (let index = 1; index <= 5; index += 1) {
      sink.append(traceEvent(`t${index}`, 1, TRACE_BASE_AT + index));
    }

    expect(sink.size()).toBe(3);
    // 丢弃是预期行为，而且要数得出来——工作台得知道自己看的不是全部。
    expect(sink.dropped()).toBe(2);
    expect((await sink.query({})).map((event) => event.turnId)).toEqual(["t3", "t4", "t5"]);
  });
});
