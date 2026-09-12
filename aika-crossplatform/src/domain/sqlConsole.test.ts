import { describe, expect, it } from "vitest";
import {
  classifyStatement, formatCell, SQL_ROW_LIMIT, stripSqlLiterals,
  toColumnInfo, toResultTable, toTableInfo,
} from "./sqlConsole";

describe("stripSqlLiterals", () => {
  it("剥掉字符串、注释与括号标识符", () => {
    const { code } = stripSqlLiterals(
      "SELECT * FROM [my table] WHERE a = 'x' -- drop table t\nAND b = \"y\" /* delete */ AND c = 1",
    );

    expect(code).not.toMatch(/drop|delete/i);
    expect(code).toMatch(/SELECT \* FROM\s+WHERE a =\s+AND b =\s+AND c = 1/);
  });

  it("'' 是转义的单引号，不是字符串结束", () => {
    const { code } = stripSqlLiterals("SELECT 'it''s; DROP TABLE t' AS a");

    // 认错了这里就会把 DROP 当成语句体，正常查询被误杀。
    expect(code).not.toMatch(/drop/i);
    expect(code.replace(/\s+/g, " ").trim()).toBe("SELECT AS a");
  });

  it("没闭合的引号吃到结尾，不把后面的内容当代码", () => {
    expect(stripSqlLiterals("SELECT 'unterminated DROP TABLE t").code.replace(/\s+/g, " ").trim()).toBe("SELECT");
  });
});

describe("classifyStatement 只读门禁（FE-12-C）", () => {
  it("放行 SELECT / WITH / EXPLAIN", () => {
    expect(classifyStatement("SELECT * FROM messages LIMIT 10")).toEqual({ ok: true, kind: "select" });
    expect(classifyStatement("  with recent as (select * from messages) select * from recent  "))
      .toEqual({ ok: true, kind: "select" });
    expect(classifyStatement("EXPLAIN QUERY PLAN SELECT * FROM memories")).toEqual({ ok: true, kind: "explain" });
    expect(classifyStatement("SELECT * FROM messages;")).toEqual({ ok: true, kind: "select" });
  });

  it("拒绝写语句，并说清楚是哪个词", () => {
    for (const [sql, word] of [
      ["DELETE FROM memories", "DELETE"],
      ["insert into messages values (1)", "INSERT"],
      ["UPDATE memories SET content = 'x'", "UPDATE"],
      ["DROP TABLE messages", "DROP"],
      ["alter table messages add column x", "ALTER"],
      ["CREATE TABLE t (a int)", "CREATE"],
      ["VACUUM", "VACUUM"],
    ] as const) {
      const verdict = classifyStatement(sql);
      expect(verdict.ok, sql).toBe(false);
      if (!verdict.ok) expect(verdict.detail).toContain(word);
    }
  });

  it("CTE 后面接写也拦得住", () => {
    // 首个关键字是 WITH，只看开头就会放行——这正是要剥完再扫全句的原因。
    const verdict = classifyStatement("WITH x AS (SELECT id FROM memories) DELETE FROM memories WHERE id IN (SELECT id FROM x)");

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("writeKeyword");
  });

  it("多语句拒绝：分号后面还有东西", () => {
    const verdict = classifyStatement("SELECT 1; DROP TABLE memories");

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toBe("multipleStatements");
      expect(verdict.detail).toContain("一次只能跑一条");
    }
  });

  it("注释里藏写不会骗过门禁，也不会误杀", () => {
    // 注释被剥掉，所以既不会被当成写，也不会因为出现 DROP 就拒绝整条。
    expect(classifyStatement("SELECT 1 -- DROP TABLE memories")).toEqual({ ok: true, kind: "select" });
    expect(classifyStatement("/* DELETE */ SELECT 1")).toEqual({ ok: true, kind: "select" });
    // 但注释不能把真正的写语句藏起来。
    const hidden = classifyStatement("SELECT 1 /* x */; /* y */ DELETE FROM memories");
    expect(hidden.ok).toBe(false);
  });

  it("字符串字面量里的写关键字不误杀（FE-12-C）", () => {
    expect(classifyStatement("SELECT * FROM messages WHERE content LIKE '%delete%'"))
      .toEqual({ ok: true, kind: "select" });
    expect(classifyStatement("SELECT * FROM memories WHERE content = 'drop table'"))
      .toEqual({ ok: true, kind: "select" });
  });

  it("列名里含关键字不误杀：按词边界找", () => {
    expect(classifyStatement("SELECT deleted_at, created_at FROM messages"))
      .toEqual({ ok: true, kind: "select" });
    expect(classifyStatement("SELECT * FROM updates_log")).toEqual({ ok: true, kind: "select" });
  });

  it("PRAGMA：只读项放行，可写项与白名单外的拒绝", () => {
    expect(classifyStatement("PRAGMA table_info(memories)")).toEqual({ ok: true, kind: "pragma" });
    expect(classifyStatement("pragma database_list")).toEqual({ ok: true, kind: "pragma" });

    const write = classifyStatement("PRAGMA journal_mode=WAL");
    expect(write.ok).toBe(false);
    if (!write.ok) expect(write.reason).toBe("writablePragma");

    const unknown = classifyStatement("PRAGMA writable_schema");
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.reason).toBe("writablePragma");
  });

  it("白名单里的 PRAGMA 带等号也拒绝：等号就是在写", () => {
    // 白名单目前全是只读项，所以这条等号判定是冲着「以后往白名单里加了一个
    // 可设置的 PRAGMA」去的。没有它，那一天会安静地开一个写入口。
    const verdict = classifyStatement("PRAGMA table_info = memories");

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toBe("writablePragma");
      expect(verdict.detail).toContain("等号");
    }
  });

  it("ATTACH 拒绝：它能把另一个库挂进来绕过一切", () => {
    const verdict = classifyStatement("ATTACH DATABASE 'other.db' AS other");

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("notReadOnly");
  });

  it("空语句与纯注释给「没有可执行的语句」，不给一句莫名其妙的拒绝", () => {
    for (const sql of ["", "   ", "-- 只是个注释", "/* 想了想 */"]) {
      const verdict = classifyStatement(sql);
      expect(verdict.ok, sql).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toBe("empty");
    }
  });
});

describe("toResultTable", () => {
  it("列取所有行键的并集，缺字段补 null 而不是错位", () => {
    const table = toResultTable([{ a: 1, b: "x" }, { a: 2, c: true }], 12);

    expect(table.columns).toEqual(["a", "b", "c"]);
    expect(table.rows).toEqual([[1, "x", null], [2, null, true]]);
    expect(table.elapsedMs).toBe(12);
    expect(table.truncated).toBe(false);
  });

  it("超过上限就标 truncated，不假装这就是全部（FE-12-D）", () => {
    const rows = Array.from({ length: 5 }, (_, index) => ({ id: index }));
    const table = toResultTable(rows, 1, 3);

    expect(table.rows).toHaveLength(3);
    expect(table.truncated).toBe(true);
    expect(SQL_ROW_LIMIT).toBeGreaterThan(0);
  });

  it("不是数组就是空结果，不抛错", () => {
    expect(toResultTable(undefined, 0)).toMatchObject({ columns: [], rows: [], truncated: false });
  });
});

describe("schema 视图", () => {
  it("sqlite_master 一行转成表信息；没有建表 SQL 就是 null（FE-12-A/B）", () => {
    expect(toTableInfo({ name: "messages", type: "table", sql: "CREATE TABLE messages(...)" }, 42))
      .toEqual({ name: "messages", kind: "table", sql: "CREATE TABLE messages(...)", rowCount: 42 });
    expect(toTableInfo({ name: "v_recent", type: "view", sql: null }, null))
      .toEqual({ name: "v_recent", kind: "view", sql: null, rowCount: null });
  });

  it("pragma_table_info 一行转成列信息", () => {
    expect(toColumnInfo({ name: "id", type: "TEXT", notnull: 1, pk: 1, dflt_value: null }))
      .toEqual({ name: "id", type: "TEXT", notNull: true, primaryKey: true, defaultValue: null });
    expect(toColumnInfo({ name: "count", type: "", notnull: 0, pk: 0, dflt_value: "0" }))
      .toEqual({ name: "count", type: "—", notNull: false, primaryKey: false, defaultValue: "0" });
  });
});

describe("formatCell", () => {
  it("NULL 与空串看得出区别", () => {
    // 两者在表格里都是「什么都没有」，但含义完全不同。
    expect(formatCell(null)).toBe("NULL");
    expect(formatCell("")).toBe("''");
    expect(formatCell(0)).toBe("0");
  });

  it("长文本截断并标出来", () => {
    expect(formatCell("x".repeat(50), 10)).toBe(`${"x".repeat(10)}…`);
  });

  it("对象按 JSON 显示", () => {
    expect(formatCell({ a: 1 })).toBe('{"a":1}');
  });
});
