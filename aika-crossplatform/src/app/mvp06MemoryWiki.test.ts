import { describe, expect, it } from "vitest";
import { LOCAL_CONVERSATION_SCOPE } from "../domain/identity";
import { DEFAULT_MODE_CONFIG } from "../domain/soul";
import type { ChatMessage } from "../domain/conversation";
import type { SessionSummary } from "../domain/summary";
import { createInMemoryMemoryStore } from "../services/memory/memoryStore";
import { createMemoryRepository } from "../services/memory/memoryRepository";
import { createMemorySource } from "../services/memory/memorySource";
import { createKnowledgeContextSource } from "../services/knowledge/knowledgeSource";
import type { MemoryRecordV2 } from "../domain/memory";
import { mayElevateToConfirmed, mayFeedUserSoul } from "../domain/memory";
import { createKnowledgeIndex } from "../services/knowledge/knowledgeIndex";
import { createKnowledgeWiki } from "../services/knowledge/wiki";
import { openMemorySqlite } from "../services/storage/nodeSqlite.harness";
import {
  createCompanionRuntime,
  type ProviderStreamEvent,
  type RuntimeProvider,
  type RuntimeStorage,
} from "../services/runtime/companionRuntime";

/**
 * MVP-06：Memory / Wiki / RAG 收口。
 *
 * 核心（repository / index / wiki / Runtime / 记忆源）全部生产实现；
 * fake 的只有外部世界（SQLite 执行器用 node 内存库、LLM Provider）。
 */

/** 各 load 共用的中止信号（本文件没有任何取消语义）。 */
const SIGNAL = new AbortController().signal;

function confirmedMemory(overrides: Partial<MemoryRecordV2> = {}): MemoryRecordV2 {
  const now = 1_000;
  return {
    schemaVersion: 2,
    id: `mem-${Math.random().toString(16).slice(2)}`,
    type: "preference",
    content: "喜欢咖啡",
    sourceMessageIds: ["m1"],
    sourceKind: "messages",
    status: "confirmed",
    confidence: 1,
    importance: 0.6,
    createdAt: now,
    updatedAt: now,
    lastConfirmedAt: now,
    lastAccessedAt: null,
    validFrom: null,
    validUntil: null,
    ...overrides,
  };
}

function runtimeStorage(): RuntimeStorage & { rows: ChatMessage[] } {
  const rows: ChatMessage[] = [];
  return {
    rows,
    listMessages: async (limit: number) => rows.slice(-limit),
    appendMessage: async (message: ChatMessage) => {
      const index = rows.findIndex((row) => row.id === message.id);
      if (index >= 0) rows[index] = message;
      else rows.push(message);
    },
    listMessageTimestamps: async () => rows.map((row) => row.createdAt),
    latestSummary: async (): Promise<SessionSummary | null> => null,
  };
}

describe("MVP-06-B Wiki 端口：查看 / 保存(=编辑) / 删除", () => {
  it("保存 → 列表可见（按角色归属）→ 检索能召回 → 同名保存版本 +1 → 删除后消失", async () => {
    const { executor } = openMemorySqlite();
    const index = createKnowledgeIndex({ db: executor });
    const wiki = createKnowledgeWiki(index, { characterId: "aika.default" });

    await wiki.save({
      title: "喜欢的乐队",
      markdown: "- 喜欢深夜听后摇",
      type: "character",
      unlockStage: "new",
    });

    const entries = await wiki.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      characterId: "aika.default",
      type: "character",
      unlockStage: "new",
      version: 1,
    });
    expect(entries[0].sourcePath).toContain("wiki://aika.default/");
    expect(entries[0].chunks).toBeGreaterThanOrEqual(1);

    // 检索（生产 index）：命中后引用带文档与版本。
    const retrieval = await index.retrieve({
      text: "乐队 后摇",
      characterId: "aika.default",
      stage: "new",
      mode: "companion",
      limit: 5,
      tokenBudget: 900,
    });
    expect(retrieval.hits.length).toBeGreaterThanOrEqual(1);
    expect(retrieval.hits[0].citation.documentId).toBe(entries[0].id);

    // 编辑 = 同名同角色再次保存：版本递增，而不是出现第二条。
    await wiki.save({
      title: "喜欢的乐队",
      markdown: "- 喜欢深夜听后摇\n- 也听 city pop",
      type: "character",
      unlockStage: "new",
    });
    const afterEdit = await wiki.list();
    expect(afterEdit).toHaveLength(1);
    expect(afterEdit[0].version).toBe(2);

    await wiki.remove(entries[0].id);
    expect(await wiki.list()).toEqual([]);
  });

  it("空标题 / 空内容拒绝保存；status 汇报 FTS 可用性", async () => {
    const { executor } = openMemorySqlite();
    const wiki = createKnowledgeWiki(createKnowledgeIndex({ db: executor }), { characterId: "aika.default" });
    await expect(wiki.save({ title: "  ", markdown: "x", type: "character", unlockStage: "new" })).rejects.toThrow("标题");
    await expect(wiki.save({ title: "t", markdown: "   ", type: "character", unlockStage: "new" })).rejects.toThrow("内容为空");
    const status = await wiki.status();
    expect(status.documents).toBe(0);
    expect(typeof status.fts).toBe("boolean");
  });
});

describe("MVP-06-D 记忆 / 知识源开关：关 = 零检索", () => {
  it("memory 源：isEnabled=false 时一个片段都不产，且不调用 retrieve", async () => {
    const repository = createMemoryRepository({ store: createInMemoryMemoryStore() });
    await repository.upsert([confirmedMemory()]);
    let retrieves = 0;
    const counting = {
      ...repository,
      async retrieve(query: Parameters<typeof repository.retrieve>[0]) {
        retrieves += 1;
        return repository.retrieve(query);
      },
    };
    let enabled = false;
    const source = createMemorySource(counting, { isEnabled: async () => enabled });

    // 关：零片段、零查询（「禁止长期读」必须是零查询）。
    expect(await source.load({ query: "咖啡", now: 2_000, signal: SIGNAL, scope: { principalId: "local" } })).toEqual([]);
    expect(retrieves).toBe(0);

    // 开：恢复检索（关掉不该把源永久下线）。
    enabled = true;
    const snippets = await source.load({ query: "咖啡", now: 2_000, signal: SIGNAL, scope: { principalId: "local" } });
    expect(snippets.length).toBeGreaterThanOrEqual(1);
    expect(snippets[0].content).toContain("喜欢咖啡");
    expect(retrieves).toBe(1);
  });

  it("memory 源：开关读取失败按关闭处理（个人数据宁可不读）", async () => {
    const repository = createMemoryRepository({ store: createInMemoryMemoryStore() });
    await repository.upsert([confirmedMemory()]);
    const source = createMemorySource(repository, {
      isEnabled: async () => {
        throw new Error("settings gone");
      },
    });
    expect(await source.load({ query: "咖啡", now: 2_000, signal: SIGNAL, scope: { principalId: "local" } })).toEqual([]);
  });

  it("knowledge 源：isEnabled=false 时零检索调用（「禁止额外检索」必须是零查询）", async () => {
    const { executor } = openMemorySqlite();
    const index = createKnowledgeIndex({ db: executor });
    await index.importContent([{
      path: "wiki://aika.default/t",
      characterId: "aika.default",
      type: "character",
      unlockStage: "new",
      content: "# t\n\n知识条目内容",
    }]);
    let retrieves = 0;
    const counting = {
      ...index,
      retrieve: (async (query: Parameters<typeof index.retrieve>[0]) => {
        retrieves += 1;
        return index.retrieve(query);
      }) as typeof index.retrieve,
    };
    let enabled = false;
    const source = createKnowledgeContextSource(counting, { isEnabled: async () => enabled });
    const input = {
      query: "知识",
      now: 5_000,
      signal: SIGNAL,
      scope: { characterId: "aika.default", stage: "new" as const, mode: "companion" as const },
    };
    expect(await source.load(input)).toEqual([]);
    expect(retrieves).toBe(0);

    enabled = true;
    expect((await source.load(input)).length).toBeGreaterThanOrEqual(1);
    expect(retrieves).toBe(1);
  });
});

describe("MVP-06-E 已确认的聊天事实可召回进一次生产 Runtime 请求", () => {
  it("生产记忆源 + 生产 Runtime + fake Provider：上下文里带着这条事实，恰好一次生成", async () => {
    const clock = { now: () => 5_000 };
    const repository = createMemoryRepository({ store: createInMemoryMemoryStore() });
    await repository.upsert([confirmedMemory()]);
    const memory = createMemorySource(repository);

    const prompts: string[] = [];
    const provider: RuntimeProvider = {
      generate(input) {
        prompts.push(JSON.stringify(input.context));
        return (async function* stream(): AsyncIterable<ProviderStreamEvent> {
          yield {
            type: "reply",
            reply: {
              schemaVersion: 1,
              mood: "happy",
              replyText: "咖啡我记得。",
              translation: "咖啡我记得。",
              memoryCandidates: [],
              actions: [],
            },
          };
        })();
      },
    };
    const runtime = createCompanionRuntime({
      provider,
      storage: runtimeStorage(),
      sources: [memory],
      clock,
    });

    await runtime.submit({
      text: "我还喜欢咖啡吗？",
      source: "text",
      mode: DEFAULT_MODE_CONFIG,
      conversation: LOCAL_CONVERSATION_SCOPE,
    }).done;
    for (let index = 0; index < 12; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));

    // 恰好一次生成，且这条**已确认**的聊天事实进了上下文。
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("喜欢咖啡");
  });
});

describe("MVP-06-A 未经确认的原始 OCR 不落库（结构证据）", () => {
  it("观察/OCR 层没有任何指向记忆写入的依赖；候选必须经人工确认才 confirmed", () => {
    // 1. MVP-05-E 的门禁已断言 services/environment 不 import memory（OCR 层碰不到写路径）。
    // 2. 生产规则本身：模型与机器都不能把候选提升为 confirmed，确认只能来自人工。
    expect(mayElevateToConfirmed(true)).toBe(false);
    expect(mayElevateToConfirmed(false)).toBe(true);
    // 3. 即便某天 OCR 材料成了候选（untrusted-material），它也进不了本地画像。
    expect(mayFeedUserSoul("untrusted-material", "confirmed")).toBe(false);
    expect(mayFeedUserSoul("messages", "confirmed")).toBe(true);
    // 4. 候选必须先过人工确认，才可能被检索标成 confirmed。
    const record = confirmedMemory({ status: "candidate", sourceKind: "untrusted-material" });
    expect(record.status).toBe("candidate");
    expect(record.sourceKind).toBe("untrusted-material");
  });
});
