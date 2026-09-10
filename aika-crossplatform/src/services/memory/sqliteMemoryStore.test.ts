import { describe, expect, it } from "vitest";
import { createMemoryV2, memoryContentHash, type MemoryRecordV2 } from "../../domain/memory";
import { emptySnapshot } from "./memoryStore";
import { createSqliteMemoryStore, MEMORY_MIGRATION_SETTING_KEY, MEMORY_V2_SCHEMA, type SqlExecutor } from "./sqliteMemoryStore";

const NOW = 1_788_998_400_000;

function record(id: string, content: string): MemoryRecordV2 {
  return createMemoryV2({ id, content, now: NOW, sourceMessageIds: ["msg-1"] }) as MemoryRecordV2;
}

/** 记录 SQL 调用的假库：够用来验证事务边界，不代替真实 SQLite。 */
class FakeDb implements SqlExecutor {
  statements: string[] = [];
  failOn: string | null = null;
  rows: Record<string, unknown[]> = { memories_v2: [], memory_suppressions: [], settings: [] };

  async execute(query: string): Promise<unknown> {
    this.statements.push(query.split("\n")[0].trim());
    if (this.failOn && query.includes(this.failOn)) throw new Error(`SQL 失败：${this.failOn}`);
    return undefined;
  }

  async select<T>(query: string): Promise<T> {
    this.statements.push(query.split("\n")[0].trim());
    if (query.includes("memories_v2")) return (this.rows.memories_v2 ?? []) as T;
    if (query.includes("memory_suppressions")) return (this.rows.memory_suppressions ?? []) as T;
    return (this.rows.settings ?? []) as T;
  }
}

describe("SQLite 记忆存储结构", () => {
  it("建表语句包含 FTS5 虚拟表与替代关系列", () => {
    const schema = MEMORY_V2_SCHEMA.join("\n");
    expect(schema).toContain("USING fts5");
    expect(schema).toContain("CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts");
    expect(schema).toContain("supersedes_id");
    expect(schema).toContain("valid_until");
    expect(schema).toContain("source_message_ids");
  });

  it("保存走显式事务：BEGIN → 写内容 → 同步 FTS → 写抑制标记 → 更新迁移版本 → COMMIT", async () => {
    const db = new FakeDb();
    const store = createSqliteMemoryStore(db);
    const suppression = {
      id: "gone", contentHash: memoryContentHash("删掉的事"), sourceMessageIds: ["msg-9"], createdAt: NOW,
    };

    await store.save({
      ...emptySnapshot(),
      records: [record("m1", "咖啡只喝浅烘焙")],
      suppressions: [suppression],
      migrationVersion: 1,
    });

    const statements = db.statements;
    expect(statements[0]).toBe("BEGIN");
    expect(statements[statements.length - 1]).toBe("COMMIT");
    expect(statements.some((statement) => statement.startsWith("DELETE FROM memory_fts"))).toBe(true);
    expect(statements.filter((statement) => statement.startsWith("INSERT INTO memory_fts"))).toHaveLength(1);
    expect(statements.some((statement) => statement.startsWith("INSERT INTO memory_suppressions"))).toBe(true);
    // 迁移版本在事务最后更新：整批都写进去了才算这次迁移完成。
    const versionIndex = statements.findIndex((statement) => statement.startsWith("INSERT INTO settings"));
    expect(versionIndex).toBeGreaterThan(statements.indexOf("COMMIT") - 2);
    expect(statements[versionIndex + 1]).toBe("COMMIT");
  });

  it("写到一半失败就回滚，不留半截数据", async () => {
    const db = new FakeDb();
    db.failOn = "INSERT INTO memory_fts";
    const store = createSqliteMemoryStore(db);

    await expect(store.save({ ...emptySnapshot(), records: [record("m1", "咖啡")] }))
      .rejects.toThrow("SQL 失败");
    expect(db.statements).toContain("ROLLBACK");
    expect(db.statements).not.toContain("COMMIT");
  });

  it("读取时能还原记录、抑制标记与迁移版本", async () => {
    const db = new FakeDb();
    db.rows.settings = [{ value: "1" }];
    db.rows.memories_v2 = [{
      id: "m1", type: "preference", content: "咖啡只喝浅烘焙",
      source_message_ids: "[\"msg-1\"]", source_kind: "messages", status: "confirmed",
      confidence: 0.9, importance: 0.8, created_at: NOW, updated_at: NOW,
      last_confirmed_at: NOW, last_accessed_at: null, valid_from: null, valid_until: null, supersedes_id: null,
    }];
    db.rows.memory_suppressions = [{
      id: "gone", content_hash: "h1", source_message_ids: "[\"msg-9\"]", created_at: NOW,
    }];

    const snapshot = await createSqliteMemoryStore(db).load();
    expect(snapshot.migrationVersion).toBe(1);
    expect(snapshot.records[0]).toMatchObject({
      id: "m1", type: "preference", status: "confirmed", confidence: 0.9, sourceMessageIds: ["msg-1"],
    });
    expect(snapshot.suppressions[0]).toMatchObject({ id: "gone", sourceMessageIds: ["msg-9"] });
    expect(MEMORY_MIGRATION_SETTING_KEY).toBe("memory.migrationVersion");
  });
});
