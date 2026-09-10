/**
 * 真实 SQLite 上的记忆存储验证。
 *
 * 与 sqliteMemoryStore.test.ts 的区别：那边用假执行器断言 SQL 文本与调用顺序，
 * 这边把 Node 内置 SQLite（`node:sqlite`）当作 `SqlExecutor`，真的建表、真的开事务、
 * 真的跑 FTS5 MATCH。它能证明的只有「SQL 与 SQLite 引擎行为一致」，
 * 不能代替 Tauri 里 @tauri-apps/plugin-sql 的接入验证。
 */

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createMemoryV2, memoryContentHash, type MemoryRecordV2 } from "../../domain/memory";
import { ensureMemorySchema, createSqliteMemoryStore, ftsQueryOf, type SqlExecutor } from "./sqliteMemoryStore";
import { createMemoryRepository } from "./memoryRepository";
import { emptySnapshot } from "./memoryStore";

const NOW = 1_788_998_400_000;

class NodeSqliteExecutor implements SqlExecutor {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * 生产 SQL 用的是 @tauri-apps/plugin-sql 的 `$1` 命名占位符，
   * node:sqlite 走位置绑定，所以这里按出现顺序映射成 `?`（允许重复与乱序）。
   */
  private bind(query: string, values: unknown[]): { sql: string; params: unknown[] } {
    const order: number[] = [];
    const sql = query.replace(/\$(\d+)/g, (_match, index: string) => {
      order.push(Number(index));
      return "?";
    });
    return { sql, params: order.map((index) => values[index - 1] ?? null) };
  }

  async execute(query: string, bindValues: unknown[] = []): Promise<unknown> {
    if (!bindValues.length) {
      this.db.exec(query);
      return undefined;
    }
    const { sql, params } = this.bind(query, bindValues);
    return this.db.prepare(sql).run(...(params as never[]));
  }

  async select<T>(query: string, bindValues: unknown[] = []): Promise<T> {
    const { sql, params } = this.bind(query, bindValues);
    return this.db.prepare(sql).all(...(params as never[])) as T;
  }
}

async function openStore() {
  const db = new DatabaseSync(":memory:");
  const executor = new NodeSqliteExecutor(db);
  await ensureMemorySchema(executor);
  // settings 表由主存储建立；这里补上，迁移版本写在它里面。
  await executor.execute("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  return { db, executor, store: createSqliteMemoryStore(executor) };
}

function record(id: string, content: string, overrides: Partial<MemoryRecordV2> = {}): MemoryRecordV2 {
  return {
    ...(createMemoryV2({ id, content, now: NOW, sourceMessageIds: ["msg-1"], type: "preference" }) as MemoryRecordV2),
    ...overrides,
  };
}

describe("FTS 查询构造", () => {
  it("CJK 展开成 3-gram，拉丁按整词；2 字词返回空串交给全量兜底", () => {
    expect(ftsQueryOf("浅烘焙")).toBe('"浅烘焙"');
    expect(ftsQueryOf("咖啡")).toBe("");
    expect(ftsQueryOf("allergic")).toBe('"allergic"');
    expect(ftsQueryOf("上个周末他去了哪里")).toContain('"上个周"');
    expect(ftsQueryOf("上个周末他去了哪里")).toContain(" OR ");
  });
});

describe("真实 SQLite · 记忆存储", () => {
  it("能在真实 SQLite 上建出 FTS5 虚拟表", async () => {
    const { db } = await openStore();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
    const names = tables.map((row) => row.name);
    expect(names).toContain("memories_v2");
    expect(names).toContain("memory_suppressions");
    // FTS5 虚拟表在 sqlite_master 里以影子表形式存在。
    expect(names.some((name) => name.startsWith("memory_fts"))).toBe(true);
  });

  it("保存后读取一致，迁移版本写进 settings", async () => {
    const { store } = await openStore();
    await store.save({
      ...emptySnapshot(),
      records: [record("m1", "喝咖啡只喝浅烘焙")],
      suppressions: [{
        id: "gone", contentHash: memoryContentHash("删掉的事"), sourceMessageIds: ["msg-9"], createdAt: NOW,
      }],
      migrationVersion: 1,
    });

    const snapshot = await store.load();
    expect(snapshot.migrationVersion).toBe(1);
    expect(snapshot.records).toHaveLength(1);
    expect(snapshot.records[0]).toMatchObject({
      id: "m1", type: "preference", sourceMessageIds: ["msg-1"], status: "candidate", importance: 0.5,
    });
    expect(snapshot.suppressions[0]).toMatchObject({ id: "gone", sourceMessageIds: ["msg-9"] });
  });

  it("二次保存覆盖旧数据而不是累积", async () => {
    const { store } = await openStore();
    await store.save({ ...emptySnapshot(), records: [record("m1", "第一条"), record("m2", "第二条")] });
    await store.save({ ...emptySnapshot(), records: [record("m2", "第二条")] });

    const snapshot = await store.load();
    expect(snapshot.records.map((item) => item.id)).toEqual(["m2"]);
  });

  it("写入中途失败时整批回滚，旧数据一个字都不动", async () => {
    const { store } = await openStore();
    await store.save({ ...emptySnapshot(), records: [record("m1", "原本就在的记忆")] });

    // 主键冲突：第一条插进去、第二条炸掉，必须整体回滚。
    await expect(store.save({
      ...emptySnapshot(),
      records: [record("dup", "先插进去的"), record("dup", "会冲突的")],
    })).rejects.toThrow();

    const snapshot = await store.load();
    expect(snapshot.records).toHaveLength(1);
    expect(snapshot.records[0].content).toBe("原本就在的记忆");
  });

  it("FTS 索引与内容同生共死：清空后不再召回", async () => {
    const { db, store } = await openStore();
    await store.save({ ...emptySnapshot(), records: [record("m1", "喜欢傍晚散步")] });
    expect(await store.searchIds?.("傍晚散步")).toEqual(["m1"]);

    await store.save({ ...emptySnapshot(), records: [] });
    expect(await store.searchIds?.("傍晚散步")).toEqual([]);
    const rows = db.prepare("SELECT COUNT(*) AS total FROM memory_fts").get() as { total: number };
    expect(rows.total).toBe(0);
  });

  it("trigram 能召回 3 字以上子串，2 字词由全量兜底", async () => {
    const { store } = await openStore();
    await store.save({
      ...emptySnapshot(),
      records: [
        record("zh", "喝咖啡只喝浅烘焙"),
        record("ja", "通勤電車で30分、朝は7時に起きる"),
        record("en", "allergic to peanuts"),
      ],
    });

    // 3 字以上：trigram 子串命中（实测 SQLite 3.45）。
    expect(await store.searchIds?.("浅烘焙")).toContain("zh");
    expect(await store.searchIds?.("喝咖啡")).toContain("zh");
    expect(await store.searchIds?.("起きる")).toContain("ja");
    expect(await store.searchIds?.("allergic")).toContain("en");
    expect(await store.searchIds?.("allerg")).toContain("en");

    // 2 字中文词：trigram 需要 3 个字符，召回为空——所以存储层必须允许回退全量。
    expect(await store.searchIds?.("咖啡")).toEqual([]);
    expect(await store.searchIds?.("通勤")).toEqual([]);
  });

  it("repository 走真实 SQLite 时，2 字词靠全量兜底仍然检索得到", async () => {
    const { store } = await openStore();
    await store.save({
      ...emptySnapshot(),
      records: [record("zh", "喝咖啡只喝浅烘焙"), record("other", "喜欢傍晚散步")],
    });
    const repository = createMemoryRepository({ store, clock: () => NOW });

    const twoChar = await repository.retrieve({ text: "咖啡", now: NOW, limit: 5, tokenBudget: 200 });
    expect(twoChar.map((hit) => hit.record.id)).toContain("zh");

    const threeChar = await repository.retrieve({ text: "浅烘焙", now: NOW, limit: 5, tokenBudget: 200 });
    expect(threeChar.map((hit) => hit.record.id)).toEqual(["zh"]);

    const noAnswer = await repository.retrieve({ text: "violin", now: NOW, limit: 5, tokenBudget: 200 });
    expect(noAnswer).toEqual([]);
  });
});
