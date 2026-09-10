import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildContextClock, formatRetrievedSections, type ContextSnippet } from "../../domain/context";
import { DEFAULT_CHARACTER_SOUL, DEFAULT_MODE_CONFIG } from "../../domain/soul";
import { computeRelationship, deriveRelationshipSignals } from "../../domain/relationship";
import { createContextAssembler } from "../context/contextAssembler";
import type { MemoryRecordV2 } from "../../domain/memory";
import { createInMemoryMemoryStore } from "./memoryStore";
import { createMemoryRepository } from "./memoryRepository";
import { createMemorySource } from "./memorySource";

const fixture = JSON.parse(
  readFileSync(new URL("../../../../docs/llm/reports/evidence/LLM_03_RETRIEVAL_FIXTURE.json", import.meta.url), "utf8"),
) as { now: number; memories: MemoryRecordV2[] };

const NOW = fixture.now;

/**
 * 10 个跨会话样本：记忆来自「以前的会话」，问句来自「现在这一轮」。
 * 口径是用户回头问自己说过的事（第一人称），与真实对话一致。
 */
const SAMPLES: Array<{
  id: string;
  query: string;
  /** 必须出现在注入内容里的事实片段。 */
  expectFacts: string[];
  /** 绝不能出现在注入内容里的片段：被取代、过期或与本次无关。 */
  forbidFacts: string[];
}> = [
  { id: "s01", query: "我平时喝咖啡的口味来着", expectFacts: ["喝咖啡只喝浅烘焙"], forbidFacts: ["喜欢拿铁"] },
  { id: "s02", query: "私のお菓子の好みは甘いのと塩気どっちだったっけ", expectFacts: ["塩気のあるお菓子"], forbidFacts: ["巧克力"] },
  { id: "s03", query: "which chocolate do I prefer", expectFacts: ["dark chocolate"], forbidFacts: ["浅烘焙"] },
  { id: "s04", query: "我的工作是什么来着", expectFacts: ["前端工程师"], forbidFacts: ["涩谷"] },
  { id: "s05", query: "私は朝何時に起きるんだっけ", expectFacts: ["朝は7時に起きる"], forbidFacts: ["読書"] },
  { id: "s06", query: "which days do I work remotely again", expectFacts: ["works remotely"], forbidFacts: ["marathon"] },
  // 过期的事件允许注入（它仍然是真事），但必须带「已过去」标注，见下一个用例。
  { id: "s07", query: "上个周末我去了哪里来着", expectFacts: ["镰仓"], forbidFacts: [] },
  { id: "s08", query: "先月どこに出張したっけ", expectFacts: ["京都に出張"], forbidFacts: ["北海道"] },
  { id: "s09", query: "我养的橘猫叫什么名字", expectFacts: ["豆豆"], forbidFacts: ["柴犬"] },
  { id: "s10", query: "am I allergic to anything", expectFacts: ["peanuts"], forbidFacts: ["涩谷"] },
];

function setup() {
  const store = createInMemoryMemoryStore({
    initial: { records: fixture.memories, suppressions: [], migrationVersion: 1 },
  });
  const repository = createMemoryRepository({ store, clock: () => NOW });
  const assembler = createContextAssembler({ sources: [createMemorySource(repository)] });
  return { repository, assembler };
}

describe("LLM-03-D · 跨会话引用（fixture harness）", () => {
  it("10 个样本里至少 8 个正确注入期望事实，且不注入被取代/过期的内容", async () => {
    const { assembler } = setup();
    const failures: string[] = [];
    let hits = 0;

    for (const sample of SAMPLES) {
      const result = await assembler.assemble({
        query: sample.query,
        now: NOW,
        timeZone: "Asia/Shanghai",
        characterSoul: DEFAULT_CHARACTER_SOUL,
        relationship: computeRelationship(deriveRelationshipSignals([NOW - 86_400_000, NOW], NOW)),
        mode: DEFAULT_MODE_CONFIG,
        history: [],
      });
      const rendered = formatRetrievedSections(result.context);
      const missing = sample.expectFacts.filter((fact) => !rendered.includes(fact));
      const leaked = sample.forbidFacts.filter((fact) => rendered.includes(fact));
      if (!missing.length && !leaked.length) hits += 1;
      else failures.push(`${sample.id}: 缺 ${missing.join("/") || "-"}；泄漏 ${leaked.join("/") || "-"}`);
    }

    expect(failures).toEqual([]);
    expect(hits).toBeGreaterThanOrEqual(8);
  });

  it("注入的每条记忆都能在记忆库里找到来源，没有孤儿事实", async () => {
    const { repository, assembler } = setup();
    const known = new Set((await repository.list()).map((record) => record.content));

    for (const sample of SAMPLES) {
      const result = await assembler.assemble({
        query: sample.query,
        now: NOW,
        timeZone: "Asia/Shanghai",
        characterSoul: DEFAULT_CHARACTER_SOUL,
        relationship: computeRelationship(deriveRelationshipSignals([], NOW)),
        mode: DEFAULT_MODE_CONFIG,
        history: [],
      });
      for (const snippet of result.context.memories) {
        expect(known.has(snippet.content)).toBe(true);
        expect(snippet.source).toBe("memory");
      }
    }
  });

  it("候选记忆带「未确认」标记，已确认的不带，未确认不会被说成已确认", async () => {
    const { assembler } = setup();
    // q05 → m05 是 candidate；q01 → m01 是 confirmed。
    const candidate = await assembler.assemble({
      query: "朝は何時に起きる", now: NOW, timeZone: "Asia/Shanghai",
      characterSoul: DEFAULT_CHARACTER_SOUL,
      relationship: computeRelationship(deriveRelationshipSignals([], NOW)),
      mode: DEFAULT_MODE_CONFIG, history: [],
    });
    const confirmed = await assembler.assemble({
      query: "他平时喝什么咖啡", now: NOW, timeZone: "Asia/Shanghai",
      characterSoul: DEFAULT_CHARACTER_SOUL,
      relationship: computeRelationship(deriveRelationshipSignals([], NOW)),
      mode: DEFAULT_MODE_CONFIG, history: [],
    });

    const candidateLine = formatRetrievedSections(candidate.context).split("\n").find((line) => line.includes("7時"));
    const confirmedLine = formatRetrievedSections(confirmed.context).split("\n").find((line) => line.includes("浅烘焙"));
    expect(candidateLine).toContain("（未确认）");
    expect(confirmedLine).not.toContain("（未确认）");

    const snippets: ContextSnippet[] = confirmed.context.memories;
    expect(snippets[0].precision).toBe("confirmed");
    expect(candidate.context.memories[0].precision).toBe("unknown");
    expect(buildContextClock(NOW, "Asia/Shanghai").timeZone).toBe("Asia/Shanghai");
  });

  it("过期的事件仍然注入，但明确标注已过去", async () => {
    const { assembler } = setup();
    const result = await assembler.assemble({
      query: "北海道", now: NOW, timeZone: "Asia/Shanghai",
      characterSoul: DEFAULT_CHARACTER_SOUL,
      relationship: computeRelationship(deriveRelationshipSignals([], NOW)),
      mode: DEFAULT_MODE_CONFIG, history: [],
    });
    const line = formatRetrievedSections(result.context).split("\n").find((item) => item.includes("北海道"));
    expect(line).toContain("（已过去）");
    expect(result.context.memories[0].temporal).toBe("past");
  });

  it("被取代与被删除的记忆都不会出现在注入内容里", async () => {
    const { repository, assembler } = setup();
    const latte = fixture.memories.find((record) => record.content === "喜欢拿铁");
    expect(latte).toBeDefined();

    const before = await assembler.assemble({
      query: "他喝什么咖啡", now: NOW, timeZone: "Asia/Shanghai",
      characterSoul: DEFAULT_CHARACTER_SOUL,
      relationship: computeRelationship(deriveRelationshipSignals([], NOW)),
      mode: DEFAULT_MODE_CONFIG, history: [],
    });
    expect(formatRetrievedSections(before.context)).not.toContain("喜欢拿铁");

    await repository.forget(latte?.id as string);
    const after = await assembler.assemble({
      query: "他喝什么咖啡", now: NOW, timeZone: "Asia/Shanghai",
      characterSoul: DEFAULT_CHARACTER_SOUL,
      relationship: computeRelationship(deriveRelationshipSignals([], NOW)),
      mode: DEFAULT_MODE_CONFIG, history: [],
    });
    expect(formatRetrievedSections(after.context)).toContain("浅烘焙");
    expect(formatRetrievedSections(after.context)).not.toContain("拿铁");
  });
});
