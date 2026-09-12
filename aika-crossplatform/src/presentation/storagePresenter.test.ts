import { describe, expect, it } from "vitest";
import { openMemorySqlite } from "../services/storage/nodeSqlite.harness";
import { createSqliteStorage } from "../services/storage/sqliteStorage";
import { userMessage } from "../domain/conversation";
import { createStoragePresenter } from "./storagePresenter";

/**
 * 跑在 **node:sqlite 真实引擎**上，不是假执行器。
 *
 * 只读门禁要拦的是「真的会执行的语句」：拿假执行器断言 SQL 文本，等于门禁自己
 * 判自己的卷子。这里让被拦下的语句**真的有机会写坏一张表**，再去证明它没写坏。
 */
async function setup() {
  const { executor } = openMemorySqlite();
  // 用生产的建表逻辑，表结构与真实库一致。
  const storage = await createSqliteStorage(executor);
  await storage.appendMessage({ ...userMessage("你好", 1_700_000_000_000), id: "m1" });
  await storage.appendMessage({ ...userMessage("元気？", 1_700_000_001_000), id: "m2" });
  const presenter = createStoragePresenter({ executor, now: () => 0, previewLimit: 1 });
  return { presenter, executor, storage };
}

async function countMessages(executor: { select<T>(sql: string): Promise<T> }): Promise<number> {
  const rows = await executor.select<{ n: number }[]>("SELECT COUNT(*) AS n FROM messages");
  return Number(rows[0]?.n ?? -1);
}

describe("createStoragePresenter", () => {
  it("没有 sqlExecutor 时 available 为 false，不给一张空表（FE-12-E）", async () => {
    const presenter = createStoragePresenter({ executor: null });
    await presenter.start();

    expect(presenter.getSnapshot()).toMatchObject({ available: false, tables: [], result: null });
  });

  it("列出表与视图，带行数（FE-12-A）", async () => {
    const { presenter } = await setup();
    await presenter.start();
    const view = presenter.getSnapshot();

    const messages = view.tables.find((table) => table.name === "messages");
    expect(messages).toMatchObject({ kind: "table", rowCount: 2 });
    expect(messages?.sql).toContain("CREATE TABLE");
    // 建表语句是真实存储建的，不是测试里手写的。
    expect(view.tables.map((table) => table.name)).toContain("settings");
  });

  it("选中一张表：列信息来自 pragma，附带建表 SQL 与前 N 行预览（FE-12-B/D）", async () => {
    const { presenter } = await setup();
    await presenter.start();
    await presenter.selectTable("messages");
    const view = presenter.getSnapshot();

    expect(view.selectedTable).toBe("messages");
    expect(view.columns.find((column) => column.name === "id")).toMatchObject({ primaryKey: true });
    expect(view.columns.map((column) => column.name)).toContain("created_at");
    expect(view.createSql).toContain("messages");
    // previewLimit 是 1，库里有 2 行：必须标出来还有没显示的。
    expect(view.result?.rows).toHaveLength(1);
    expect(view.result?.truncated).toBe(true);
    expect(view.resultSource).toBe("preview");
  });

  it("控制台跑 SELECT 拿到结果（FE-12-A）", async () => {
    const { presenter } = await setup();
    await presenter.start();
    presenter.setQuery("SELECT id, role FROM messages ORDER BY created_at");
    await presenter.runQuery();
    const view = presenter.getSnapshot();

    expect(view.error).toBe("");
    expect(view.columns.length).toBeGreaterThanOrEqual(0);
    expect(view.result?.columns).toEqual(["id", "role"]);
    expect(view.result?.rows.map((row) => row[0])).toEqual(["m1", "m2"]);
    expect(view.resultSource).toBe("console");
  });

  it("写语句被拦在执行之前：库里一行没少（FE-12-C）", async () => {
    const { presenter, executor } = await setup();
    await presenter.start();

    for (const sql of [
      "DELETE FROM messages",
      "UPDATE messages SET text = 'x'",
      "DROP TABLE messages",
      "SELECT 1; DELETE FROM messages",
      "WITH x AS (SELECT id FROM messages) DELETE FROM messages",
      "PRAGMA journal_mode=WAL",
      "ATTACH DATABASE 'other.db' AS other",
    ]) {
      presenter.setQuery(sql);
      await presenter.runQuery();
      const view = presenter.getSnapshot();

      expect(view.result, sql).toBeNull();
      expect(view.error, sql).not.toBe("");
      // 这才是这条用例的重点：真引擎、真表，两行消息一行都不能少。
      expect(await countMessages(executor), sql).toBe(2);
    }
  });

  it("拒绝理由具体到「是哪个词 / 是几条语句」（FE-12-C）", async () => {
    const { presenter } = await setup();
    await presenter.start();

    presenter.setQuery("DELETE FROM messages");
    await presenter.runQuery();
    expect(presenter.getSnapshot().error).toContain("DELETE");

    presenter.setQuery("SELECT 1; SELECT 2");
    await presenter.runQuery();
    expect(presenter.getSnapshot().error).toContain("一次只能跑一条");
  });

  it("字符串里带写关键字的正常查询照跑（FE-12-C）", async () => {
    const { presenter } = await setup();
    await presenter.start();
    presenter.setQuery("SELECT id FROM messages WHERE content LIKE '%delete%'");
    await presenter.runQuery();

    // 误杀和漏判一样糟：这条查询完全正当。
    expect(presenter.getSnapshot().error).toBe("");
    expect(presenter.getSnapshot().result?.rows).toEqual([]);
  });

  it("SQL 报错如实显示，不吞掉也不清空表清单", async () => {
    const { presenter } = await setup();
    await presenter.start();
    presenter.setQuery("SELECT * FROM 没有这张表");
    await presenter.runQuery();
    const view = presenter.getSnapshot();

    expect(view.error).not.toBe("");
    expect(view.result).toBeNull();
    expect(view.tables.length).toBeGreaterThan(0);
  });

  it("PRAGMA table_info 这类只读语句放行", async () => {
    const { presenter } = await setup();
    await presenter.start();
    presenter.setQuery("PRAGMA table_info(messages)");
    await presenter.runQuery();

    expect(presenter.getSnapshot().error).toBe("");
    expect(presenter.getSnapshot().result?.columns).toContain("name");
  });

  it("空语句给「没有可执行的语句」，不发请求", async () => {
    const { presenter } = await setup();
    await presenter.start();
    presenter.setQuery("   ");
    await presenter.runQuery();

    expect(presenter.getSnapshot().error).toContain("没有可执行的语句");
  });
});
