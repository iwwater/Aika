import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createMemoryV2, memoryContentHash, type MemoryRecord, type MemoryRecordV2 } from "../../domain/memory";
import { createInMemoryMemoryStore, type MemorySuppression } from "./memoryStore";
import { createMemoryRepository, MEMORY_MIGRATION_VERSION, type MemoryInvalidation } from "./memoryRepository";
import { createLocalMemoryStore, type KeyValueBackend } from "./localMemoryStore";

const NOW = 1_788_998_400_000;
const DAY = 86_400_000;

function record(overrides: Partial<MemoryRecordV2> & { id: string; content: string }): MemoryRecordV2 {
  return createMemoryV2({
    id: overrides.id,
    content: overrides.content,
    type: overrides.type,
    status: overrides.status,
    importance: overrides.importance,
    sourceMessageIds: overrides.sourceMessageIds,
    sourceKind: overrides.sourceKind,
    now: overrides.createdAt ?? NOW - 7 * DAY,
  }) as MemoryRecordV2;
}

function repository(initial: { records?: MemoryRecordV2[]; suppressions?: MemorySuppression[] } = {}) {
  const store = createInMemoryMemoryStore({
    initial: { records: initial.records ?? [], suppressions: initial.suppressions ?? [] },
  });
  const invalidations: MemoryInvalidation[] = [];
  const repo = createMemoryRepository({
    store,
    clock: () => NOW,
    onInvalidate: (event) => {
      invalidations.push(event);
    },
  });
  return { store, repo, invalidations };
}

/* ---------------------------------- AC-A ---------------------------------- */

interface RetrievalFixture {
  now: number;
  topK: number;
  tokenBudget: number;
  memories: MemoryRecordV2[];
  questions: Array<{
    id: string;
    language: string;
    text: string;
    expectHitIds: string[];
    expectEmpty: boolean;
  }>;
}

const fixture: RetrievalFixture = JSON.parse(
  readFileSync(new URL("../../../../docs/llm/reports/evidence/LLM_03_RETRIEVAL_FIXTURE.json", import.meta.url), "utf8"),
) as RetrievalFixture;

describe("LLM-03-A · 固定样本检索", () => {
  it("样本规模满足 AC 下限，且覆盖三语", () => {
    expect(fixture.memories.length).toBeGreaterThanOrEqual(30);
    expect(fixture.questions).toHaveLength(20);
    const languages = new Set(fixture.questions.map((question) => question.language));
    expect([...languages].sort()).toEqual(["en", "ja", "zh"]);
    expect(fixture.questions.filter((question) => question.expectEmpty).length).toBe(5);
  });

  it("15 个有答案问题里至少 13 个 Top-5 命中，5 个无答案问题返回空集", async () => {
    const { repo } = repository({ records: fixture.memories });
    const answered = fixture.questions.filter((question) => !question.expectEmpty);
    const unanswerable = fixture.questions.filter((question) => question.expectEmpty);

    const misses: string[] = [];
    for (const question of answered) {
      const hits = await repo.retrieve({
        text: question.text, now: fixture.now, limit: fixture.topK, tokenBudget: fixture.tokenBudget,
      });
      const topIds = hits.map((hit) => hit.record.id);
      if (!question.expectHitIds.some((id) => topIds.includes(id))) {
        misses.push(`${question.id}(${question.text}) → ${topIds.join(",") || "空"}`);
      }
    }

    const falsePositives: string[] = [];
    for (const question of unanswerable) {
      const hits = await repo.retrieve({
        text: question.text, now: fixture.now, limit: fixture.topK, tokenBudget: fixture.tokenBudget,
      });
      if (hits.length) falsePositives.push(`${question.id}(${question.text}) → ${hits.map((hit) => hit.record.id).join(",")}`);
    }

    expect(misses.length).toBeLessThanOrEqual(2);
    expect(falsePositives).toEqual([]);
    expect(answered.length).toBe(15);
  });

  it("superseded 与过期的非事件记忆不会出现在结果里", async () => {
    const { repo } = repository({ records: fixture.memories });
    const coffeeHits = await repo.retrieve({ text: "拿铁 咖啡", now: fixture.now, limit: 10, tokenBudget: 400 });
    expect(coffeeHits.map((hit) => hit.record.id)).not.toContain("m35");

    const shibuyaHits = await repo.retrieve({ text: "涩谷", now: fixture.now, limit: 10, tokenBudget: 400 });
    expect(shibuyaHits).toEqual([]);

    const hokkaidoHits = await repo.retrieve({ text: "北海道", now: fixture.now, limit: 10, tokenBudget: 400 });
    expect(hokkaidoHits.map((hit) => hit.record.id)).toEqual(["m34"]);
    expect(hokkaidoHits[0].temporalStatus).toBe("past");
  });
});

/* ---------------------------------- AC-B ---------------------------------- */

describe("LLM-03-B · 访问、更正与删除", () => {
  it("检索只更新访问时间，不自动确认也不改确认时间", async () => {
    const { store, repo } = repository({ records: [record({ id: "m1", content: "咖啡只喝浅烘焙", status: "candidate" })] });

    await repo.retrieve({ text: "咖啡", now: NOW, limit: 5, tokenBudget: 200 });
    await repo.retrieve({ text: "咖啡", now: NOW + DAY, limit: 5, tokenBudget: 200 });

    const [stored] = store.current().records;
    expect(stored.status).toBe("candidate");
    expect(stored.lastConfirmedAt).toBeNull();
    expect(stored.lastAccessedAt).toBe(NOW + DAY);
  });

  it("supersede 是原子替换：旧记录转 superseded 并记下替代关系", async () => {
    const { store, repo } = repository({ records: [record({ id: "old", content: "喜欢拿铁" })] });
    await repo.supersede("old", record({ id: "new", content: "只喝浅烘焙", type: "preference", status: "confirmed" }));

    const records = store.current().records;
    expect(records.find((item) => item.id === "old")?.status).toBe("superseded");
    expect(records.find((item) => item.id === "new")?.supersedesId).toBe("old");
  });

  it("事务失败时快照保持旧值，不会写一半", async () => {
    const { store, repo } = repository({ records: [record({ id: "m1", content: "咖啡只喝浅烘焙" })] });
    store.failNextSave = true;

    await expect(repo.upsert([record({ id: "m2", content: "住在横滨" })])).rejects.toThrow("存储写入失败");
    expect(store.current().records.map((item) => item.id)).toEqual(["m1"]);
  });

  it("删除 → 重载 → 再抽取不会复活，且来源被抑制", async () => {
    const { store, repo, invalidations } = repository({
      records: [record({ id: "m1", content: "咖啡只喝浅烘焙", sourceMessageIds: ["msg-1"] })],
    });

    expect(await repo.forget("m1")).toBe(true);
    expect(store.current().records).toEqual([]);
    // 抑制标记只留指纹与来源，不留正文。
    const suppression = store.current().suppressions[0];
    expect(suppression.contentHash).toBe(memoryContentHash("咖啡只喝浅烘焙"));
    expect(suppression.sourceMessageIds).toEqual(["msg-1"]);
    expect(JSON.stringify(store.current())).not.toContain("浅烘焙");
    expect(invalidations).toHaveLength(1);

    // 同一来源、同一内容再次写回 —— 不能复活。
    await repo.upsert([record({ id: "m9", content: "咖啡只喝浅烘焙", sourceMessageIds: ["msg-1"] })]);
    expect(store.current().records).toEqual([]);

    // 用户亲手重新写一遍 —— 这是新来源，可以重新记住。
    await repo.upsert([record({
      id: "m10", content: "咖啡只喝浅烘焙", sourceMessageIds: [], sourceKind: "userEdit",
    })]);
    expect(store.current().records.map((item) => item.id)).toEqual(["m10"]);
  });

  it("删除不存在的记录是幂等的，不写抑制标记", async () => {
    const { store, repo } = repository({ records: [] });
    expect(await repo.forget("missing")).toBe(false);
    expect(store.current().suppressions).toEqual([]);
    expect(store.saveCount).toBe(0);
  });

  it("旧库迁移两次不丢失、不重复", async () => {
    const legacy: MemoryRecord[] = [
      { id: "v1-a", category: "偏好", content: "喜欢傍晚散步", status: "confirmed", createdAt: NOW - 10 * DAY, updatedAt: NOW - 10 * DAY },
      { id: "v1-b", category: "日常", content: "周末去了海边", status: "pending", createdAt: NOW - 9 * DAY, updatedAt: NOW - 9 * DAY },
      { id: "v1-c", category: "人际", content: "妹妹在大阪", status: "pending", createdAt: NOW - 8 * DAY, updatedAt: NOW - 8 * DAY },
    ];
    const { store, repo } = repository();

    expect(await repo.migrateLegacy(legacy)).toBe(3);
    const first = store.current();
    expect(first.records).toHaveLength(3);
    expect(first.migrationVersion).toBe(MEMORY_MIGRATION_VERSION);

    expect(await repo.migrateLegacy(legacy)).toBe(0);
    const second = store.current();
    expect(second.records.map((item) => item.id).sort()).toEqual(["v1-a", "v1-b", "v1-c"]);

    const byId = new Map(second.records.map((item) => [item.id, item]));
    expect(byId.get("v1-a")).toMatchObject({
      type: "preference", status: "confirmed", importance: 0.5, sourceKind: "legacy", sourceMessageIds: [],
    });
    expect(byId.get("v1-b")).toMatchObject({ type: "event", status: "candidate", confidence: null });
    expect(byId.get("v1-c")).toMatchObject({ type: "relationship", status: "candidate" });
    // 旧消息没有来源时不许编一个出来。
    expect(second.records.every((item) => item.sourceMessageIds.length === 0)).toBe(true);
  });
});

/* ------------------------------ localStorage ------------------------------ */

describe("localStorage 快照降级", () => {
  function backend() {
    const raw = new Map<string, string>();
    const state = { failNext: false };
    const kv: KeyValueBackend = {
      get: (key) => raw.get(key) ?? null,
      set: (key, value) => {
        if (state.failNext) {
          state.failNext = false;
          throw new Error("QuotaExceededError");
        }
        raw.set(key, value);
      },
    };
    return { kv, raw, state };
  }

  it("整份快照一次替换，写失败时旧快照不变", async () => {
    const storage = backend();
    const store = createLocalMemoryStore(storage.kv);
    const repo = createMemoryRepository({ store, clock: () => NOW });

    await repo.upsert([record({ id: "m1", content: "咖啡只喝浅烘焙" })]);
    const before = storage.raw.get("aika.memories.v2");
    expect(before).toContain("浅烘焙");

    storage.state.failNext = true;
    await expect(repo.upsert([record({ id: "m2", content: "住在横滨" })])).rejects.toThrow("QuotaExceededError");
    expect(storage.raw.get("aika.memories.v2")).toBe(before);

    const reloaded = await store.load();
    expect(reloaded.records.map((item) => item.id)).toEqual(["m1"]);
  });
});
