import { describe, expect, it } from "vitest";
import { openMemorySqlite } from "../storage/nodeSqlite.harness";
import type { SqlExecutor } from "../memory/sqliteMemoryStore";
import type { KnowledgeIndex } from "./knowledgeIndex";
import { createKnowledgeIndex } from "./knowledgeIndex";
import { createKnowledgeContextSource } from "./knowledgeSource";

/**
 * LLM-05 固定验证语料（**冻结**：先于任何断言结果写定，不再为过测试而改语料）。
 * 三个主题文档三语各一段（应用本身是日中双语+英语场景）；两个阶段受限文档。
 * 问题与预期来源在 AC 用例表里逐条固定；阈值用 domain 冻结的 KNOWLEDGE_MIN_SCORE。
 */

const CORPUS: Record<string, string> = {
  "coffee.md": [
    "# 咖啡与日常",
    "她喝咖啡只喝浅烘焙，而且不加糖。",
    "コーヒーは浅煎りだけ、砂糖は入れない。",
    "She only drinks light roast coffee without sugar.",
    "",
    "# 周末习惯",
    "周末她沿着河边散步一个小时。",
    "週末は川沿いを一時間散歩する。",
    "On weekends she walks along the river for an hour.",
  ].join("\n"),
  "london.md": [
    "# 伦敦交通",
    "伦敦地铁进出站要刷同一张卡。",
    "ロンドンの地下鉄は同じカードで改札を通る。",
    "The London Underground requires tapping the same card in and out.",
  ].join("\n"),
  "job.md": [
    "# 工作变动",
    "她正在考虑换工作，想去小一点的团队。",
    "転職を考えていて、小さなチームに移りたいと言っていた。",
    "She is considering changing jobs to a smaller team.",
  ].join("\n"),
  "pronunciation.md": [
    "# 发音练习方法",
    "发音练习先慢速跟读，再逐句录音回听。",
    "発音練習はまずゆっくりシャドーイングして、毎句録音して聞き直す。",
    "Pronunciation practice starts with slow shadowing, then records and reviews sentence by sentence.",
  ].join("\n"),
  "rain.md": [
    "# 雨季",
    "这里的雨季在六月，出门要带伞。",
    "梅雨は六月で、出かける時は傘が必要。",
    "The rainy season is in June, so carry an umbrella.",
  ].join("\n"),
};

const ENTRIES = [
  { path: "coffee.md", characterId: "aika", type: "character" as const, unlockStage: "new" as const, tags: ["日常"] },
  { path: "london.md", characterId: "aika", type: "world" as const, unlockStage: "new" as const, tags: ["旅行"] },
  { path: "job.md", characterId: "aika", type: "character" as const, unlockStage: "familiar" as const, tags: ["工作"] },
  {
    path: "pronunciation.md", characterId: "aika", type: "oral" as const, unlockStage: "close" as const,
    tags: ["练习"], allowedModes: ["oral_practice" as const],
  },
  { path: "rain.md", characterId: "aika", type: "world" as const, unlockStage: "new" as const, tags: ["季节"] },
];

const reader = { read: async (path: string) => {
  const raw = CORPUS[path];
  if (raw === undefined) throw new Error(`文件不存在（注入）：${path}`);
  return raw;
} };

function makeIndex(db?: SqlExecutor, fileReader: unknown = reader): KnowledgeIndex {
  const { executor } = openMemorySqlite();
  return createKnowledgeIndex({
    db: db ?? executor,
    readFile: fileReader as { read(path: string): Promise<string> },
  });
}

/** AC-A 用例表：**先于运行冻结**。期望=答案所在文档；查询按语言分组。 */
const ANSWERABLE_CASES: Array<{ q: string; expectedPath: string; mode?: "companion" | "oral_practice" }> = [
  { q: "她喝咖啡有什么讲究", expectedPath: "coffee.md" },
  { q: "周末她喜欢做什么", expectedPath: "coffee.md" },
  { q: "伦敦地铁怎么刷卡", expectedPath: "london.md" },
  { q: "她换工作的事情怎么样了", expectedPath: "job.md" },
  { q: "发音练习应该怎么开始", expectedPath: "pronunciation.md", mode: "oral_practice" },
  { q: "コーヒーについて教えて", expectedPath: "coffee.md" },
  { q: "週末の過ごし方は？", expectedPath: "coffee.md" },
  { q: "転職の話はどうなった？", expectedPath: "job.md" },
  { q: "発音練習のコツは？", expectedPath: "pronunciation.md", mode: "oral_practice" },
  { q: "梅雨の時期はいつ？", expectedPath: "rain.md" },
  { q: "What coffee does she drink", expectedPath: "coffee.md" },
  { q: "How does the London Underground gate work", expectedPath: "london.md" },
  { q: "Is she changing jobs", expectedPath: "job.md" },
  { q: "How to practice pronunciation", expectedPath: "pronunciation.md", mode: "oral_practice" },
  { q: "When is the rainy season", expectedPath: "rain.md" },
];

/** 无答案问题：共享领域语气但语料中没有任何真实证据；**先于运行冻结**。 */
const NO_ANSWER_CASES = [
  "她养猫了吗",
  "猫を飼っていますか",
  "Does she have a cat",
  "她会不会弹钢琴",
  "ピアノを弾ける？",
];

async function seededIndex(): Promise<KnowledgeIndex> {
  const index = makeIndex();
  const result = await index.importDocuments(ENTRIES);
  expect(result.updated).toBe(5);
  return index;
}

describe("LLM-05-A 固定语料检索命中（真实临时 SQLite FTS5）", () => {
  it("15 个有答案问题 ≥13/15 落入 Top-5 且命中预期文档", async () => {
    const index = await seededIndex();
    let passed = 0;
    const failures: string[] = [];
    for (const item of ANSWERABLE_CASES) {
      const { hits } = await index.retrieve({
        text: item.q, characterId: "aika", stage: "close", mode: item.mode ?? "companion",
        limit: 5, tokenBudget: 4000,
      });
      const hit = hits.some((entry) => entry.document.sourcePath === item.expectedPath);
      if (hit) passed += 1;
      else failures.push(`${item.q} → [${hits.map((entry) => entry.document.sourcePath).join(", ")}]`);
    }
    expect(failures).toEqual([]);
    expect(passed).toBeGreaterThanOrEqual(13);
  });

  it("5 个无答案问题返回无可靠证据（空命中）", async () => {
    const index = await seededIndex();
    for (const question of NO_ANSWER_CASES) {
      const { hits } = await index.retrieve({
        text: question, characterId: "aika", stage: "close", mode: "companion",
        limit: 5, tokenBudget: 4000,
      });
      expect(hits, question).toEqual([]);
    }
  });
});

describe("LLM-05-B 解锁过滤先于 Top-K 与缓存", () => {
  it("10 个未解锁查询：受限文档注入数为 0", async () => {
    const index = await seededIndex();
    const restricted = ["job.md", "pronunciation.md"];
    const queries = [
      "换工作", "転職", "changing jobs", "工作变动", "小さなチーム",
      "发音练习", "発音練習", "pronunciation", "录音回听", "shadowing",
    ];
    expect(queries).toHaveLength(10);
    for (const question of queries) {
      const { hits } = await index.retrieve({
        text: question, characterId: "aika", stage: "new", mode: "companion",
        limit: 5, tokenBudget: 4000,
      });
      const leaked = hits.filter((entry) => restricted.includes(entry.document.sourcePath));
      expect(leaked, question).toEqual([]);
    }
  });

  it("Mode/角色/阶段变化后缓存键正确：同键复用，跨键重算", async () => {
    const index = await seededIndex();
    const query = { text: "発音練習のコツは？", characterId: "aika", limit: 5, tokenBudget: 4000 } as const;

    const closeOral = await index.retrieve({ ...query, stage: "close", mode: "oral_practice" });
    const closeOralAgain = await index.retrieve({ ...query, stage: "close", mode: "oral_practice" });
    expect(closeOralAgain).toBe(closeOral); // 同键命中缓存（同一对象）。

    const newStage = await index.retrieve({ ...query, stage: "new", mode: "oral_practice" });
    expect(newStage).not.toBe(closeOral);
    expect(newStage.hits).toEqual([]); // close 文档在 new 阶段不可见。

    const companionMode = await index.retrieve({ ...query, stage: "close", mode: "companion" });
    expect(companionMode).not.toBe(closeOral);
    expect(companionMode.hits).toEqual([]); // oral 文档不在 companion 白名单。

    const otherCharacter = await index.retrieve({ ...query, characterId: "other", stage: "close", mode: "oral_practice" });
    expect(otherCharacter.hits).toEqual([]);
  });
});

describe("LLM-05-C 版本切换与降级", () => {
  it("更新走新版本：旧内容不再出现，其余文档不受影响", async () => {
    // 可变语料从**原版**出发：先导入 v1（不加糖），再真正改内容触发 v2。
    const mutableCorpus: Record<string, string> = { ...CORPUS };
    const index = makeIndex(undefined, { read: async (path: string) => {
      const raw = mutableCorpus[path];
      if (raw === undefined) throw new Error(`文件不存在（注入）：${path}`);
      return raw;
    } });
    await index.importDocuments(ENTRIES);
    const before = await index.retrieve({
      text: "她喝咖啡有什么讲究", characterId: "aika", stage: "new", mode: "companion", limit: 5, tokenBudget: 4000,
    });
    expect(before.hits[0]?.document.version).toBe(1);
    expect(JSON.stringify(before.hits)).toContain("不加糖");

    mutableCorpus["coffee.md"] = CORPUS["coffee.md"].replace("不加糖", "加两份糖");
    const updated = await index.importDocuments([{ ...ENTRIES[0] }]);
    expect(updated.updated).toBe(1);

    const after = await index.retrieve({
      text: "她喝咖啡有什么讲究", characterId: "aika", stage: "new", mode: "companion", limit: 5, tokenBudget: 4000,
    });
    expect(after.hits[0]?.document.version).toBe(2);
    expect(JSON.stringify(after.hits)).not.toContain("不加糖");
    expect(JSON.stringify(after.hits)).toContain("加两份糖");
  });

  it("删除使新查询看不到文档，其他文档保留", async () => {
    const index = await seededIndex();
    const rows = await index.retrieve({
      text: "伦敦地铁刷卡", characterId: "aika", stage: "new", mode: "companion", limit: 5, tokenBudget: 4000,
    });
    const target = rows.hits.find((entry) => entry.document.sourcePath === "london.md");
    expect(target).toBeDefined();
    await index.removeDocument(target!.document.id);

    const after = await index.retrieve({
      text: "伦敦地铁刷卡", characterId: "aika", stage: "new", mode: "companion", limit: 5, tokenBudget: 4000,
    });
    expect(after.hits).toEqual([]);
    const coffee = await index.retrieve({
      text: "她喝咖啡有什么讲究", characterId: "aika", stage: "new", mode: "companion", limit: 5, tokenBudget: 4000,
    });
    expect(coffee.hits.length).toBeGreaterThan(0);
  });

  it("导入失败保留上个可用版本", async () => {
    const index = await seededIndex();
    await expect(index.importDocuments([{ path: "missing.md", characterId: "aika", type: "world", unlockStage: "new" }]))
      .rejects.toThrow("文件不存在");
    const still = await index.retrieve({
      text: "她喝咖啡有什么讲究", characterId: "aika", stage: "new", mode: "companion", limit: 5, tokenBudget: 4000,
    });
    expect(still.hits.length).toBeGreaterThan(0);
    expect(still.hits[0]?.document.version).toBe(1);
  });

  it("FTS 不可用：显式降级原因，检索仍然可用", async () => {
    const { executor } = openMemorySqlite();
    const noFtsExecutor: SqlExecutor = {
      execute: async (query: string, values?: unknown[]) => {
        if (query.toUpperCase().includes("VIRTUAL TABLE")) {
          throw new Error("fts5 not supported（注入）");
        }
        return executor.execute(query, values);
      },
      select: executor.select.bind(executor),
    };
    const index = makeIndex(noFtsExecutor);
    await index.importDocuments(ENTRIES);
    expect(index.status().fts).toBe(false);

    const { hits, degraded } = await index.retrieve({
      text: "她喝咖啡有什么讲究", characterId: "aika", stage: "new", mode: "companion", limit: 5, tokenBudget: 4000,
    });
    expect(degraded).toContain("FTS 不可用");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.document.sourcePath).toBe("coffee.md");
  });
});

describe("LLM-05-E 安全与装配边界", () => {
  it("scope 切换：close 可见的知识对 new 隐藏（source 层默认拒绝）", async () => {
    const index = await seededIndex();
    const source = createKnowledgeContextSource(index);
    const signal = new AbortController().signal;

    const missingScope = await source.load({ query: "転職の話はどうなった？", now: 0, signal });
    expect(missingScope).toEqual([]);

    const hidden = await source.load({ query: "転職の話はどうなった？", now: 0, signal, scope: { characterId: "aika", stage: "new", mode: "companion" } });
    expect(hidden).toEqual([]);

    const visible = await source.load({ query: "転職の話はどうなった？", now: 0, signal, scope: { characterId: "aika", stage: "close", mode: "companion" } });
    expect(visible.length).toBeGreaterThan(0);
    expect(visible[0]?.source).toContain("knowledge:");
  });

  it("同内容哈希不同权限：元数据变化激活新版本", async () => {
    const index = await seededIndex();
    // coffee.md 内容不变，只把解锁阶段 new → familiar。
    const result = await index.importDocuments([{ ...ENTRIES[0], unlockStage: "familiar" }]);
    expect(result.updated).toBe(1);

    const atNew = await index.retrieve({
      text: "她喝咖啡有什么讲究", characterId: "aika", stage: "new", mode: "companion", limit: 5, tokenBudget: 4000,
    });
    expect(atNew.hits).toEqual([]);

    const atFamiliar = await index.retrieve({
      text: "她喝咖啡有什么讲究", characterId: "aika", stage: "familiar", mode: "companion", limit: 5, tokenBudget: 4000,
    });
    expect(atFamiliar.hits.length).toBeGreaterThan(0);
    expect(atFamiliar.hits[0]?.document.version).toBe(2);
  });

  it("并发导入：一个失败不影响另一个，状态一致", async () => {
    const index = makeIndex();
    const good = index.importDocuments([{ ...ENTRIES[0] }]);
    const bad = index.importDocuments([{ path: "missing.md", characterId: "aika", type: "world", unlockStage: "new" }]);
    const results = await Promise.allSettled([good, bad]);
    expect(results[0].status).toBe("fulfilled");
    expect(results[1].status).toBe("rejected");

    const { hits } = await index.retrieve({
      text: "她喝咖啡有什么讲究", characterId: "aika", stage: "new", mode: "companion", limit: 5, tokenBudget: 4000,
    });
    expect(hits.length).toBeGreaterThan(0);
  });

  it("恶意 MATCH 表达式不炸库、不扩成全库命中", async () => {
    const index = await seededIndex();
    for (const malicious of ['" OR 1=1 --', "咖啡* NEAR OR \"", "\"\"\"\"", "a OR b OR c OR 咖啡"]) {
      const { hits, degraded } = await index.retrieve({
        text: malicious, characterId: "aika", stage: "new", mode: "companion", limit: 5, tokenBudget: 4000,
      });
      // 命中要么为空，要么确实包含查询里的真实词（如「咖啡」）。
      for (const hit of hits) {
        expect(hit.chunk.text).toContain("咖啡");
      }
      void degraded;
    }
  });
});
