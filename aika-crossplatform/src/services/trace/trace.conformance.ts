import { describe, expect, it } from "vitest";
import { TRACE_SCHEMA_VERSION, type TraceEventV1 } from "../../domain/trace";
import type { TraceSink } from "./contracts";

/**
 * TraceSink 的端口一致性用例包。
 *
 * 每个实现都跑这一份。它只断言**契约层面可观测的行为**：写进去读得回来、时序怎么
 * 还原、tail 的方向与上限、过滤怎么生效、写入失败时会不会把主链路带下去。
 *
 * 它刻意不断言 SQL、不断言缓冲区内部结构——那些是实现细节，写进用例包就等于把两个
 * 实现焊死。它也不证明持久性与并发等价：内存环形缓冲会主动丢最旧的，SQLite 不会。
 */

/**
 * 用例包里所有时间戳的基准。
 *
 * 不能用 100、200 这种小数字：落盘实现带保留期清理，拿真实时钟一比，
 * 「1970 年的那条」立刻就是过期数据，第一次写入就会把它自己扫掉。
 * 基准放在一个真实纪元上，落盘 harness 再把时钟注到同一个点。
 */
export const TRACE_BASE_AT = 1_700_000_000_000;

export interface TraceSinkHarness {
  name: string;
  create(): Promise<{
    subject: TraceSink;
    dispose(): Promise<void>;
    /** 让底层写入从此刻开始失败，用来验 fail-open。不支持就不提供。 */
    breakWrites?(): void;
  }>;
}

export function traceEvent(
  turnId: string,
  seq: number,
  at: number,
  overrides: Partial<Extract<TraceEventV1, { kind: "turn_start" }>> = {},
): TraceEventV1 {
  return {
    schemaVersion: TRACE_SCHEMA_VERSION,
    turnId,
    seq,
    at,
    kind: "turn_start",
    source: "text",
    mode: "daily",
    text: null,
    ...overrides,
  };
}

function endEvent(turnId: string, seq: number, at: number): TraceEventV1 {
  return {
    schemaVersion: TRACE_SCHEMA_VERSION,
    turnId,
    seq,
    at,
    kind: "turn_end",
    status: "completed",
    durationMs: 120,
    tokens: { estimatedPrompt: 42, reportedTotal: null },
  };
}

export function runTraceSinkConformance(harness: TraceSinkHarness): void {
  describe(`TraceSink 契约 · ${harness.name}`, () => {
    async function withSink<T>(run: (sink: TraceSink, control: { breakWrites?(): void }) => Promise<T>): Promise<T> {
      const { subject, dispose, breakWrites } = await harness.create();
      try {
        return await run(subject, { breakWrites });
      } finally {
        await dispose();
      }
    }

    it("写进去读得回来，载荷逐字保留", async () => {
      await withSink(async (sink) => {
        sink.append(traceEvent("t1", 1, TRACE_BASE_AT + 100));
        sink.append(endEvent("t1", 2, TRACE_BASE_AT + 220));
        await sink.flush();

        const events = await sink.query({ turnId: "t1" });

        expect(events.map((event) => event.seq)).toEqual([1, 2]);
        const end = events[1];
        expect(end.kind).toBe("turn_end");
        if (end.kind === "turn_end") {
          expect(end.durationMs).toBe(120);
          // 不知道就是 null，不许写 0：0 会被成本页画成「不花钱」。
          expect(end.tokens.reportedTotal).toBeNull();
          expect(end.tokens.estimatedPrompt).toBe(42);
        }
      });
    });

    it("时序按 turnId + seq 还原，不靠写入顺序", async () => {
      await withSink(async (sink) => {
        // 故意乱序写同一轮的三条
        sink.append(traceEvent("t1", 3, TRACE_BASE_AT + 300));
        sink.append(traceEvent("t1", 1, TRACE_BASE_AT + 100));
        sink.append(traceEvent("t1", 2, TRACE_BASE_AT + 200));
        await sink.flush();

        expect((await sink.query({ turnId: "t1" })).map((event) => event.seq)).toEqual([1, 2, 3]);
      });
    });

    it("tail 是倒序、尊重 limit", async () => {
      await withSink(async (sink) => {
        sink.append(traceEvent("t1", 1, TRACE_BASE_AT + 100));
        sink.append(traceEvent("t2", 1, TRACE_BASE_AT + 200));
        sink.append(traceEvent("t3", 1, TRACE_BASE_AT + 300));
        await sink.flush();

        const latest = await sink.tail(2);

        expect(latest.map((event) => event.turnId)).toEqual(["t3", "t2"]);
      });
    });

    it("按 kind 与 since 过滤", async () => {
      await withSink(async (sink) => {
        sink.append(traceEvent("t1", 1, TRACE_BASE_AT + 100));
        sink.append(endEvent("t1", 2, TRACE_BASE_AT + 200));
        sink.append(traceEvent("t2", 1, TRACE_BASE_AT + 300));
        await sink.flush();

        expect((await sink.query({ kind: "turn_end" })).map((event) => event.turnId)).toEqual(["t1"]);
        expect((await sink.query({ since: TRACE_BASE_AT + 200 })).map((event) => event.at))
          .toEqual([TRACE_BASE_AT + 200, TRACE_BASE_AT + 300]);
        expect(await sink.query({ limit: 0 })).toEqual([]);
      });
    });

    it("同一个 (turnId, seq) 再写是替换，不是追加", async () => {
      await withSink(async (sink) => {
        sink.append(traceEvent("t1", 1, TRACE_BASE_AT + 100));
        sink.append(traceEvent("t1", 1, TRACE_BASE_AT + 100, { text: "改过了" }));
        await sink.flush();

        const events = await sink.query({ turnId: "t1" });
        const last = events[events.length - 1];
        expect(last.kind).toBe("turn_start");
        if (last.kind === "turn_start") expect(last.text).toBe("改过了");
      });
    });

    it("查不到东西时是空数组，不是抛错", async () => {
      await withSink(async (sink) => {
        expect(await sink.query({ turnId: "从来没有过" })).toEqual([]);
        expect(await sink.tail(5)).toEqual([]);
      });
    });

    it("fail-open：底层写坏了 append 也不抛，且后续写入不被废掉", async () => {
      await withSink(async (sink, control) => {
        if (!control.breakWrites) {
          // 不支持制造写入失败的实现（内存环形缓冲）在这里没有可验的东西。
          expect(control.breakWrites).toBeUndefined();
          return;
        }
        control.breakWrites();
        // 关键断言：这一句不抛。Trace 是旁路，主链路不该被它带下去。
        expect(() => sink.append(traceEvent("t1", 1, TRACE_BASE_AT + 100))).not.toThrow();
        await expect(sink.flush()).resolves.toBeUndefined();
      });
    });
  });
}
