import { describe, expect, it } from "vitest";
import { createContextAssembler, type AssembleInput, type ContextSource } from "./contextAssembler";
import { redactTraceEvent, type TraceRedactionPolicy } from "../../domain/trace";
import type { ContextSnippet } from "../../domain/context";

/**
 * LLM-11：装配期裁剪诊断。fixture 固定——保留与裁掉的块逐字段匹配；
 * 脱敏走唯一的 redactTraceEvent（record/订阅/导出共用这一个函数）。
 */

function snippet(source: string, content: string, extra: Partial<ContextSnippet> = {}): ContextSnippet {
  return { source, content, ...extra };
}

function sourceWith(id: string, section: "memory" | "knowledge" | "environment", snippets: ContextSnippet[]): ContextSource {
  return {
    id,
    section,
    load: async () => snippets,
  };
}

const BUDGET = { inputLimit: 6000, outputReserve: 800, safetyReserve: 400 };

function baseInput(overrides: Partial<AssembleInput> = {}): AssembleInput {
  return {
    query: "今天喝什么",
    now: 1_788_998_400_000,
    characterSoul: {
      schemaVersion: 1, id: "aika", name: "愛花", systemPrompt: "你是愛花。",
      stableTraits: [], moods: [], actions: [],
    } as unknown as AssembleInput["characterSoul"],
    relationship: { stage: "new", score: 0, signals: [], description: "" } as unknown as AssembleInput["relationship"],
    mode: { mode: "companion", params: {} } as unknown as AssembleInput["mode"],
    history: [],
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe("LLM-11-A 装配诊断：保留与裁掉逐字段匹配", () => {
  it("includeDiagnostics=true：裁剪前的块都有诊断，kept/reason/ordinal 逐字段正确", async () => {
    const assembler = createContextAssembler({
      budget: BUDGET,
      sources: [
        sourceWith("memory-fake", "memory", [
          snippet("memory", "她喝咖啡只喝浅烘焙。", { id: "mem-1", category: "偏好", precision: "confirmed" }),
          // sanitize 在 loadSource 会把内容截到 240 字左右，单块成本有限；
          // 预算靠「多块」耗尽，靠后的块自然被裁（这正是装配期该观察到的）。
          ...Array.from({ length: 40 }, (_, index) => (
            snippet("memory", `预算占位块 ${index}：${"接近上限的整段内容。".repeat(30)}`, { id: `mem-big-${index}` })
          )),
          snippet("memory", "小而靠后。", { id: "mem-3" }),
        ]),
      ],
      timers: { setTimeout: () => 0, clearTimeout: () => undefined },
    });

    const result = await assembler.assemble(baseInput({ includeDiagnostics: true }));
    expect(result.diagnostics).toBeDefined();
    const memory = result.diagnostics!.sections.find((section) => section.name === "memory")!;
    expect(memory.snippets).toHaveLength(42); // 1 小块 + 40 预算块 + 1 尾块，全部进诊断

    const [first, second] = memory.snippets;
    expect(first).toMatchObject({ source: "memory", id: "mem-1", category: "偏好", precision: "confirmed", kept: true, reason: null, ordinal: 0, temporal: null });
    expect(first.content).toContain("浅烘焙");
    // 预算耗尽后：靠后的块 kept=false + reason=trimmed，但它们在诊断里仍然可见
    //（这就是「裁剪前采集」，不是从最终 context 反推）。
    const trimmed = memory.snippets.filter((entry) => !entry.kept);
    expect(trimmed.length).toBeGreaterThan(0);
    expect(trimmed.every((entry) => entry.reason === "trimmed")).toBe(true);
    expect(second.kept).toBe(true);
    // 靠后的大块被裁；小块（mem-3，4 token）仍能塞进剩余预算——这是正确的裁剪语义。
    const big39 = memory.snippets.find((entry) => entry.id === "mem-big-39");
    expect(big39).toMatchObject({ kept: false, reason: "trimmed" });
    expect(memory.snippets[memory.snippets.length - 1]).toMatchObject({ id: "mem-3", kept: true });
    expect(result.diagnostics!.counts.snippetsTotal).toBe(42);
    expect(result.diagnostics!.counts.truncated).toBe(false);
    expect(result.diagnostics!.budget).toMatchObject({
      inputLimit: 6000, outputReserve: 800, safetyReserve: 400,
      available: 4800,
    });
    expect(result.diagnostics!.requiredBlocks.map((block) => block.name)).toEqual([
      "characterSoul", "mode", "relationship", "clock", "userSoul", "query",
    ]);
  });

  it("includeDiagnostics 缺省：不构造诊断（Trace 关时零拷贝）", async () => {
    const assembler = createContextAssembler({
      budget: BUDGET,
      sources: [sourceWith("memory-fake", "memory", [snippet("memory", "内容", { id: "m-1" })])],
      timers: { setTimeout: () => 0, clearTimeout: () => undefined },
    });
    const result = await assembler.assemble(baseInput());
    expect(result.diagnostics).toBeUndefined();
  });

  it("历史计数：recentLimit 丢弃与预算丢弃分开统计", async () => {
    const assembler = createContextAssembler({
      budget: BUDGET,
      recentTurnLimit: 3,
      sources: [],
      timers: { setTimeout: () => 0, clearTimeout: () => undefined },
    });
    const history = Array.from({ length: 5 }, (_, index) => ({
      id: `m-${index}`, role: "user" as const, text: `第 ${index} 句`, createdAt: index, completion: "complete" as const,
    })) as unknown as AssembleInput["history"];
    const result = await assembler.assemble(baseInput({ history, includeDiagnostics: true }));
    expect(result.diagnostics!.history).toMatchObject({
      inputCount: 5, normalizedCount: 5, recentLimitDropped: 2, kept: 3,
    });
  });

  it("摘要三态：none/used/skipped", async () => {
    const assembler = createContextAssembler({
      budget: BUDGET,
      sources: [],
      timers: { setTimeout: () => 0, clearTimeout: () => undefined },
    });
    const none = await assembler.assemble(baseInput({ includeDiagnostics: true }));
    expect(none.diagnostics!.summary.state).toBe("none");

    const used = await assembler.assemble(baseInput({ includeDiagnostics: true, summary: "上周聊过咖啡。" }));
    expect(used.diagnostics!.summary.state).toBe("used");

    const tinyBudget = { inputLimit: 200, outputReserve: 8, safetyReserve: 4 };
    const cramped = createContextAssembler({
      budget: tinyBudget,
      sources: [],
      timers: { setTimeout: () => 0, clearTimeout: () => undefined },
    });
    const skipped = await cramped.assemble(baseInput({ includeDiagnostics: true, summary: "一段长得会超出预算的摘要。".repeat(5) }));
    expect(skipped.diagnostics!.summary.state).toBe("skipped");
  });
});

describe("LLM-11-B 唯一脱敏点：订阅/落盘/导出一致", () => {
  it("includeText=false：content 全部置 null，正文与 canary 不外泄；元信息保留", async () => {
    const assembler = createContextAssembler({
      budget: BUDGET,
      sources: [sourceWith("memory-fake", "memory", [
        snippet("memory", "canary-SECRET-9f3 是密钥形状的内容", { id: "mem-canary" }),
      ])],
      timers: { setTimeout: () => 0, clearTimeout: () => undefined },
    });
    const result = await assembler.assemble(baseInput({ includeDiagnostics: true }));
    const event = {
      kind: "context_snapshot" as const,
      schemaVersion: 1 as const, turnId: "t", seq: 1, at: 0,
      ...result.diagnostics!,
    };
    const off = redactTraceEvent(event, { includeText: false } satisfies TraceRedactionPolicy);
    expect(JSON.stringify(off)).not.toContain("canary-SECRET");
    const section = "sections" in off ? off.sections[0].snippets[0] : null;
    expect(section).toMatchObject({ content: null, id: "mem-canary", source: "memory" });
    // 同一函数、开关打开：正文可见（用户选择带正文的路径）。
    const on = redactTraceEvent(event, { includeText: true });
    expect(JSON.stringify(on)).toContain("canary-SECRET");
  });

  it("超过 snippet 数量上限时 counts.truncated=true，不冒充全量", async () => {
    const many = Array.from({ length: 60 }, (_, index) => snippet("memory", `第 ${index} 条`, { id: `m-${index}` }));
    const assembler = createContextAssembler({
      budget: { inputLimit: 600000, outputReserve: 800, safetyReserve: 400 },
      sources: [sourceWith("memory-fake", "memory", many)],
      timers: { setTimeout: () => 0, clearTimeout: () => undefined },
    });
    const result = await assembler.assemble(baseInput({ includeDiagnostics: true }));
    const memory = result.diagnostics!.sections.find((section) => section.name === "memory")!;
    expect(memory.snippets.length).toBeLessThan(60);
    expect(result.diagnostics!.counts.truncated).toBe(true);
    expect(result.diagnostics!.counts.snippetsTotal).toBe(60);
  });
});
