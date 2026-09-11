import { describe, expect, it } from "vitest";
import { createMemoryTraceSink } from "./memoryTraceSink";
import { createTraceRecorder, NO_TRACE } from "./traceRecorder";
import type { TraceSink } from "./contracts";

const AT = 1_700_000_000_000;

function setup(options: { enabled?: boolean; includeText?: boolean } = {}) {
  const sink = createMemoryTraceSink(50);
  let now = AT;
  const recorder = createTraceRecorder({
    sink,
    clock: () => now,
    isEnabled: () => options.enabled ?? true,
    policy: () => ({ includeText: options.includeText ?? false }),
  });
  return { sink, recorder, tick: (ms: number) => { now += ms; } };
}

describe("TraceRecorder", () => {
  it("按 turnId 各自编号，从 1 起连续", async () => {
    const { sink, recorder } = setup();

    // 两轮交错发：各自的 seq 都必须从 1 连续，不能互相顶号。
    recorder.record("t1", { kind: "turn_start", source: "text", mode: "daily", text: "第一轮" });
    recorder.record("t2", { kind: "turn_start", source: "voice", mode: "daily", text: "第二轮" });
    recorder.record("t1", { kind: "provider_stream_meta", firstTokenMs: 80, chunks: 3 });
    recorder.record("t2", { kind: "provider_stream_meta", firstTokenMs: null, chunks: 0 });

    expect((await sink.query({ turnId: "t1" })).map((event) => event.seq)).toEqual([1, 2]);
    expect((await sink.query({ turnId: "t2" })).map((event) => event.seq)).toEqual([1, 2]);
  });

  it("填 schemaVersion 与时刻，调用方不用管", async () => {
    const { sink, recorder, tick } = setup();
    recorder.record("t1", { kind: "turn_start", source: "text", mode: "daily", text: null });
    tick(250);
    recorder.record("t1", { kind: "provider_stream_meta", firstTokenMs: 250, chunks: 1 });

    const events = await sink.query({ turnId: "t1" });
    expect(events.map((event) => event.at)).toEqual([AT, AT + 250]);
    expect(events.every((event) => event.schemaVersion === 1)).toBe(true);
  });

  it("脱敏只在这一处发生：正文按策略变 null", async () => {
    const off = setup({ includeText: false });
    off.recorder.record("t1", { kind: "turn_start", source: "text", mode: "daily", text: "今天有点累" });
    const [hidden] = await off.sink.query({ turnId: "t1" });
    if (hidden.kind === "turn_start") expect(hidden.text).toBeNull();

    const on = setup({ includeText: true });
    on.recorder.record("t1", { kind: "turn_start", source: "text", mode: "daily", text: "今天有点累" });
    const [shown] = await on.sink.query({ turnId: "t1" });
    if (shown.kind === "turn_start") expect(shown.text).toBe("今天有点累");
  });

  it("关掉时一个事件都不产生", async () => {
    const { sink, recorder } = setup({ enabled: false });
    recorder.record("t1", { kind: "turn_start", source: "text", mode: "daily", text: "不该出现" });
    expect(await sink.query({})).toEqual([]);
    expect(recorder.enabled()).toBe(false);
  });

  it("endTurn 之后同一个 turnId 重新从 1 开始（计数器被扔掉了）", async () => {
    const { sink, recorder } = setup();
    recorder.record("t1", { kind: "turn_start", source: "text", mode: "daily", text: null });
    recorder.endTurn("t1");
    recorder.record("t1", { kind: "turn_start", source: "text", mode: "daily", text: null });

    // 长会话不该让计数器 Map 无限长大；代价是复用同一个 id 会重号，
    // 而 turnId 是 uuid，现实中不会复用。
    expect((await sink.query({ turnId: "t1" })).map((event) => event.seq)).toEqual([1, 1]);
  });

  it("sink 抛错也不冒泡：Trace 不许把对话带下去", () => {
    const broken: TraceSink = {
      append() { throw new Error("sink 炸了"); },
      tail: async () => [],
      query: async () => [],
      flush: async () => undefined,
    };
    const recorder = createTraceRecorder({ sink: broken, clock: () => AT });

    expect(() => recorder.record("t1", {
      kind: "turn_start", source: "text", mode: "daily", text: null,
    })).not.toThrow();
  });

  it("NO_TRACE 是安静的空实现，调用方不用写 ?.", () => {
    expect(() => NO_TRACE.record("t1", { kind: "tts", sentences: 1, played: true, errorCount: 0 })).not.toThrow();
    expect(NO_TRACE.enabled()).toBe(false);
  });
});
