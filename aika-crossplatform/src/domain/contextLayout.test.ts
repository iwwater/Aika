import { describe, expect, it } from "vitest";
import { buildContextLayout } from "./contextLayout";
import { turnFlow } from "./pluginGraph";
import { buildTurnTimeline } from "./traceView";
import type { TraceContextSnapshotFields } from "./trace";
import type { TraceEventV1 } from "./trace";

/**
 * FE-25：上下文布局。fixture 快照逐字段匹配；kept/trimmed/未检索严格区分；
 * content=null 显示「正文未记录」；与工作台 turnFlow 对同一事件序列结论一致。
 */

const BASE = 1_788_998_400_000;

function snapshotFixture(): TraceContextSnapshotFields {
  return {
    budget: { inputLimit: 6000, outputReserve: 800, safetyReserve: 400, available: 4800, estimatedUsed: 900 },
    requiredBlocks: [
      { name: "characterSoul", estimatedTokens: 120 },
      { name: "query", estimatedTokens: 8 },
    ],
    history: { inputCount: 5, normalizedCount: 5, recentLimitDropped: 2, budgetDropped: 1, kept: 2 },
    summary: { state: "used", estimatedTokens: 60 },
    sections: [
      {
        name: "memory",
        estimatedTokens: 210,
        snippets: [
          { source: "memory", id: "mem-1", category: "偏好", precision: "confirmed", temporal: null, ordinal: 0, estimatedTokens: 20, kept: true, reason: null, content: "喜欢浅烘焙" },
          { source: "memory", id: null, category: null, precision: "proxy", temporal: null, ordinal: 1, estimatedTokens: 9999, kept: false, reason: "trimmed", content: "超大片段" },
        ],
      },
      { name: "knowledge", estimatedTokens: 0, snippets: [] },
      { name: "environment", estimatedTokens: 0, snippets: [] },
    ],
    counts: { snippetsTotal: 2, snippetsKept: 1, truncated: false },
  };
}

describe("FE-25-A 布局与快照逐字段匹配；三种状态严格区分", () => {
  it("kept/trimmed/notRetrieved 不混装；字段逐一对上", () => {
    const layout = buildContextLayout(snapshotFixture());
    expect(layout.supported).toBe(true);

    const memory = layout.blocks.filter((block) => block.name === "memory");
    expect(memory).toHaveLength(2);
    expect(memory[0]).toMatchObject({
      status: "kept", snippetId: "mem-1", precision: "confirmed",
      estimatedTokens: 20, content: "喜欢浅烘焙", reason: null,
    });
    // proxy 精度如实带出；无 id 片段 snippetId=null；trimmed 带原因。
    expect(memory[1]).toMatchObject({
      status: "trimmed", snippetId: null, precision: "proxy", reason: "trimmed",
    });

    // knowledge/environment 没检索到：notRetrieved，绝不伪造进 kept/trimmed。
    expect(layout.blocks.filter((block) => block.name === "knowledge"))
      .toEqual([expect.objectContaining({ status: "notRetrieved", reason: "本轮没有检索到任何片段" })]);
    expect(layout.blocks.filter((block) => block.name === "environment"))
      .toEqual([expect.objectContaining({ status: "notRetrieved" })]);

    // 历史区分 recentLimit 裁剪与预算裁剪（两项都在 reason 里可见）。
    const history = layout.blocks.find((block) => block.name === "history")!;
    expect(history.status).toBe("kept");
    expect(history.estimatedTokens).toBeNull();

    const summary = layout.blocks.find((block) => block.name === "summary")!;
    expect(summary).toMatchObject({ status: "kept", estimatedTokens: 60 });
  });

  it("recentLimit 裁剪导致历史全被丢时，reason 说清楚是哪种裁剪", () => {
    const fixture = snapshotFixture();
    fixture.history = { inputCount: 5, normalizedCount: 5, recentLimitDropped: 5, budgetDropped: 0, kept: 0 };
    const layout = buildContextLayout(fixture);
    const history = layout.blocks.find((block) => block.name === "history")!;
    expect(history.status).toBe("trimmed");
    expect(history.reason).toContain("recentLimit 裁 5");
    expect(history.reason).toContain("预算裁 0");
  });
});

describe("FE-25-B content=null 显示正文未记录，不回查存储", () => {
  it("正文开关关闭的快照：kept 片段 content=null → unrecorded 语义由 UI 呈现", () => {
    const fixture = snapshotFixture();
    fixture.sections[0].snippets[0] = { ...fixture.sections[0].snippets[0], content: null };
    const layout = buildContextLayout(fixture);
    const first = layout.blocks.find((block) => block.name === "memory")!;
    expect(first.content).toBeNull();
    // notes 提示不回查存储。
    expect(layout.notes.some((note) => note.includes("不回查存储"))).toBe(true);
  });
});

describe("FE-25-C 同事件序列与工作台 turnFlow 结论相同", () => {
  it("turnFlow 标 done 的阶段 ⇔ 时间线有该阶段；未走到 ⇔ 时间线无", () => {
    const events: TraceEventV1[] = [
      { schemaVersion: 1, turnId: "t1", seq: 1, at: BASE, kind: "turn_start", source: "text", mode: "companion", text: null },
      { schemaVersion: 1, turnId: "t1", seq: 2, at: BASE + 5, kind: "context_assemble", estimatedTokens: 100, droppedSources: [], historyDropped: 0, historyRepaired: 0, retrievedSources: [] },
      { schemaVersion: 1, turnId: "t1", seq: 3, at: BASE + 6, kind: "context_snapshot",
        budget: { inputLimit: 6000, outputReserve: 800, safetyReserve: 400, available: 4800, estimatedUsed: 100 },
        requiredBlocks: [], history: { inputCount: 0, normalizedCount: 0, recentLimitDropped: 0, budgetDropped: 0, kept: 0 },
        summary: { state: "none", estimatedTokens: 0 }, sections: [], counts: { snippetsTotal: 0, snippetsKept: 0, truncated: false } },
      { schemaVersion: 1, turnId: "t1", seq: 6, at: BASE + 90, kind: "turn_end", status: "completed", durationMs: 90, tokens: { estimatedPrompt: 100, reportedTotal: null } },
    ];
    const flow = turnFlow(events, "t1");
    const timeline = buildTurnTimeline(events, "t1");
    for (const stage of flow.stages) {
      const inTimeline = timeline!.stages.some((entry) => entry.kind === stage.kind);
      expect(inTimeline, stage.kind).toBe(stage.state !== "notReached");
    }
  });
});

describe("FE-25-D 旧协议/无快照可显示", () => {
  it("缺快照：supported=false + 引导说明，不编造布局", () => {
    const layout = buildContextLayout(null);
    expect(layout.supported).toBe(false);
    expect(layout.blocks).toEqual([]);
    expect(layout.notes[0]).toContain("没有上下文快照");
  });

  it("截断快照：notes 明示不是全量清单", () => {
    const fixture = snapshotFixture();
    fixture.counts = { snippetsTotal: 99, snippetsKept: 1, truncated: true };
    const layout = buildContextLayout(fixture);
    expect(layout.notes.some((note) => note.includes("截断"))).toBe(true);
  });
});
