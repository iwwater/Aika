import { describe, expect, it } from "vitest";
import { buildTurnTimeline, toJsonl } from "./traceView";
import type { TraceEventV1 } from "./trace";

/**
 * FE-24：泳道时间线语义——只有真实配对给耗时；乱序/重复/取消/缺 turn_end/
 * 负时钟差都不产生虚假耗时；导出与页面投影逐字节一致。
 */

const BASE = 1_788_998_400_000;

function event(turnId: string, seq: number, kind: TraceEventV1["kind"], at: number, extra: object = {}): TraceEventV1 {
  return { schemaVersion: 1, turnId, seq, at, kind, ...extra } as TraceEventV1;
}

describe("FE-24-A 时间线：真实配对与宁缺毋假", () => {
  it("完成轮：totalMs 取 turn_end.durationMs，阶段间隔为相邻差", () => {
    const timeline = buildTurnTimeline([
      event("t1", 1, "turn_start", BASE, { source: "text", mode: "companion", text: null }),
      event("t1", 2, "context_assemble", BASE + 5, { estimatedTokens: 100, droppedSources: [], historyDropped: 0, historyRepaired: 0, retrievedSources: [] }),
      event("t1", 5, "turn_end", BASE + 300, { status: "completed", durationMs: 295, tokens: { estimatedPrompt: 100, reportedTotal: null } }),
    ], "t1");
    expect(timeline).toMatchObject({
      turnId: "t1", status: "completed", totalMs: 295, firstTokenMs: null, replyIntervalMs: null,
    });
    expect(timeline!.stages.map((stage) => stage.intervalMs)).toEqual([0, 5, 295]);
  });

  it("缺 turn_end：running 且 totalMs=null，不从相邻差补算", () => {
    const timeline = buildTurnTimeline([
      event("t1", 1, "turn_start", BASE, { source: "text", mode: "companion", text: null }),
      event("t1", 2, "provider_request", BASE + 10, { protocol: "openai-compatible", model: "m", endpoint: "https://x/v1", requestChars: 10, instructionsChars: 10, instructionsDigest: null }),
    ], "t1");
    expect(timeline).toMatchObject({ status: "running", totalMs: null });
  });

  it("乱序输入被排序修复；负时钟差的间隔为 null 不显示虚假耗时", () => {
    const timeline = buildTurnTimeline([
      // 故意乱序给出（数组顺序不影响）；最后一个事件时钟早于前一个 → 负差。
      event("t1", 2, "context_assemble", BASE + 50, { estimatedTokens: 1, droppedSources: [], historyDropped: 0, historyRepaired: 0, retrievedSources: [] }),
      event("t1", 1, "turn_start", BASE, { source: "text", mode: "companion", text: null }),
      event("t1", 3, "provider_request", BASE + 40, { protocol: "p", model: "m", endpoint: "https://x", requestChars: 1, instructionsChars: 1, instructionsDigest: null }),
    ], "t1");
    // 排序后 seq 升序；seq3 的 at(40) 早于 seq2 的 at(50) → 负差 → null。
    expect(timeline!.stages.map((stage) => stage.intervalMs)).toEqual([0, 50, null]);
  });

  it("重复事件（同 turnId+seq）只计一次", () => {
    const duplicate = event("t1", 1, "turn_start", BASE, { source: "text", mode: "companion", text: null });
    const timeline = buildTurnTimeline([duplicate, duplicate, event("t1", 2, "turn_end", BASE + 10, { status: "failed", durationMs: 10, tokens: { estimatedPrompt: null, reportedTotal: null } })], "t1");
    expect(timeline!.stages).toHaveLength(2);
    expect(timeline).toMatchObject({ status: "failed", totalMs: 10 });
  });

  it("取消轮：状态如实为 cancelled；usage 缺失显示 null（未知）", () => {
    const timeline = buildTurnTimeline([
      event("t1", 1, "turn_start", BASE, { source: "text", mode: "companion", text: null }),
      event("t1", 2, "turn_end", BASE + 999, { status: "cancelled", durationMs: 999, tokens: { estimatedPrompt: null, reportedTotal: null } }),
    ], "t1");
    expect(timeline).toMatchObject({ status: "cancelled", totalMs: 999 });
    expect(timeline!.usage).toEqual({ estimatedPrompt: null, reportedTotal: null });
  });
});

describe("FE-24-C/D 导出与页面投影逐字节一致", () => {
  it("toJsonl 对同一投影数组：两次序列化逐字节一致；选中轮导出是页面序列的子集", () => {
    const events = [
      event("t1", 2, "turn_end", BASE + 30, { status: "completed", durationMs: 30, tokens: { estimatedPrompt: 10, reportedTotal: null } }),
      event("t1", 1, "turn_start", BASE, { source: "text", mode: "companion", text: null }),
      event("t2", 1, "turn_start", BASE + 100, { source: "text", mode: "companion", text: null }),
    ];
    // 页面与导出走同一个 toJsonl、同一投影数组。
    expect(toJsonl(events)).toBe(toJsonl([...events].reverse()));
    const t1Lines = toJsonl(events.filter((entry) => entry.turnId === "t1")).split("\n");
    expect(t1Lines.every((line) => JSON.parse(line).turnId === "t1")).toBe(true);
    expect(t1Lines).toHaveLength(2);
  });
});
