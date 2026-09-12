/**
 * 只读 SQL 门禁（F8）。
 *
 * 规划文档 §7 问题 3 的答案是**只读**：写进去的数据没人对得上账（记忆有抑制标记与
 * supersede 关系、消息有摘要覆盖范围），手写一条 UPDATE 不触发任何联动，库里从此
 * 是一份代码认不出来的状态。
 *
 * 这里是文本判定，**不是数据库层面的只读连接**——`plugin-sql` 只给一个执行器，
 * 没有只读连接可用。所以这层判定必须自己扛住两种错误：
 * - 漏判：`SELECT 1; DROP TABLE memories`（只看开头以为是 SELECT）；
 * - 误杀：`SELECT * FROM messages WHERE content LIKE '%delete%'`（只看关键字）。
 *
 * 两者都靠同一件事解决：**先剥掉字符串字面量与注释，再判**。
 */

export type SqlRejectReason =
  | "empty"
  | "multipleStatements"
  | "notReadOnly"
  | "writeKeyword"
  | "writablePragma";

export type SqlVerdict =
  | { ok: true; kind: "select" | "pragma" | "explain" }
  | { ok: false; reason: SqlRejectReason; detail: string };

/** 只允许这些只读 PRAGMA。白名单而不是黑名单：PRAGMA 的可写项太多，列不全。 */
const READ_ONLY_PRAGMAS = new Set([
  "table_info", "table_xinfo", "table_list", "index_list", "index_info",
  "index_xinfo", "foreign_key_list", "database_list", "collation_list",
  "compile_options", "function_list", "pragma_list", "integrity_check",
]);

/** 语句体内出现任何一个（字符串与注释之外）就拒绝。 */
const WRITE_KEYWORDS = [
  "insert", "update", "delete", "drop", "alter", "create", "replace", "truncate",
  "attach", "detach", "vacuum", "reindex", "begin", "commit", "rollback",
  "savepoint", "release", "grant", "revoke",
];

interface Stripped {
  /** 剥掉字符串字面量与注释之后的 SQL，长度与位置不保证与原文一致。 */
  code: string;
  /** 剥掉的字符串字面量个数，仅用于解释判定结果。 */
  literals: number;
}

/**
 * 剥掉注释与字面量。
 *
 * 认得四种引号：`'...'`（`''` 是转义）、`"..."`、反引号、`[...]`，以及 `--` 行注释
 * 和 `/* *\/` 块注释。剥掉的内容一律换成一个空格，避免把两个标识符粘成一个。
 */
export function stripSqlLiterals(sql: string): Stripped {
  let code = "";
  let literals = 0;
  let index = 0;

  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];

    if (char === "-" && next === "-") {
      const end = sql.indexOf("\n", index);
      index = end < 0 ? sql.length : end;
      code += " ";
      continue;
    }
    if (char === "/" && next === "*") {
      const end = sql.indexOf("*/", index + 2);
      index = end < 0 ? sql.length : end + 2;
      code += " ";
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      index += 1;
      for (; index < sql.length; index += 1) {
        if (sql[index] !== char) continue;
        // '' 是转义的单引号，不是结束。
        if (sql[index + 1] === char) {
          index += 1;
          continue;
        }
        break;
      }
      index += 1;
      literals += 1;
      code += " ";
      continue;
    }
    if (char === "[") {
      const end = sql.indexOf("]", index);
      index = end < 0 ? sql.length : end + 1;
      literals += 1;
      code += " ";
      continue;
    }
    code += char;
    index += 1;
  }

  return { code, literals };
}

function firstKeyword(code: string): string {
  return code.trim().split(/[\s(;]+/, 1)[0]?.toLowerCase() ?? "";
}

/** 判一条语句能不能跑。拒绝时给具体原因——「你写了 DELETE」和「你写了两条」要分得开。 */
export function classifyStatement(sql: string): SqlVerdict {
  const { code } = stripSqlLiterals(sql ?? "");
  const trimmed = code.trim();
  if (!trimmed) return { ok: false, reason: "empty", detail: "没有可执行的语句" };

  // 尾部分号允许；分号后面还有东西就是两条语句。
  const withoutTail = trimmed.replace(/;\s*$/, "");
  if (withoutTail.includes(";")) {
    return {
      ok: false,
      reason: "multipleStatements",
      detail: "一次只能跑一条语句：分号后面还有内容",
    };
  }

  const head = firstKeyword(withoutTail);
  if (!["select", "with", "explain", "pragma"].includes(head)) {
    return {
      ok: false,
      reason: "notReadOnly",
      detail: `只读控制台只接受 SELECT / WITH / EXPLAIN / PRAGMA，你写的是 ${head.toUpperCase() || "空语句"}`,
    };
  }

  if (head === "pragma") {
    const name = withoutTail.slice("pragma".length).trim().split(/[\s(=]+/, 1)[0]?.toLowerCase() ?? "";
    if (!READ_ONLY_PRAGMAS.has(name)) {
      return { ok: false, reason: "writablePragma", detail: `PRAGMA ${name || "?"} 不在只读白名单里` };
    }
    if (withoutTail.includes("=")) {
      return { ok: false, reason: "writablePragma", detail: "带等号的 PRAGMA 是写操作" };
    }
    return { ok: true, kind: "pragma" };
  }

  // 关键字按词边界找：`deleted_at` 这样的列名不该被当成 DELETE。
  for (const keyword of WRITE_KEYWORDS) {
    if (new RegExp(`(^|[^\\w$])${keyword}([^\\w$]|$)`, "i").test(withoutTail)) {
      return {
        ok: false,
        reason: "writeKeyword",
        detail: `语句里有 ${keyword.toUpperCase()}，只读控制台不执行写操作`,
      };
    }
  }

  return { ok: true, kind: head === "explain" ? "explain" : "select" };
}

/** 一次最多取回多少行。再多就不是「看一眼」而是把库拖进内存了。 */
export const SQL_ROW_LIMIT = 500;

export interface SqlResult {
  columns: string[];
  rows: unknown[][];
  /** 取回的行数达到上限：**还有没显示的**，不能让人以为这就是全部。 */
  truncated: boolean;
  elapsedMs: number;
}

/**
 * 把执行器返回的行数组整成表格。
 *
 * 列顺序取所有行键的并集：SQLite 驱动给的是对象数组，某一行缺字段时不能让整列错位。
 */
export function toResultTable(rows: unknown, elapsedMs: number, limit = SQL_ROW_LIMIT): SqlResult {
  const list = Array.isArray(rows) ? rows : [];
  const columns: string[] = [];
  for (const row of list) {
    if (!row || typeof row !== "object") continue;
    for (const key of Object.keys(row as Record<string, unknown>)) {
      if (!columns.includes(key)) columns.push(key);
    }
  }
  const visible = list.slice(0, limit);
  return {
    columns,
    rows: visible.map((row) => columns.map((column) => (row as Record<string, unknown>)?.[column] ?? null)),
    truncated: list.length > limit,
    elapsedMs,
  };
}

export interface TableInfo {
  name: string;
  kind: "table" | "view";
  /** 建表 SQL 原文。SQLite 内部表可能没有，那就是 null。 */
  sql: string | null;
  /** 行数。数不出来（视图报错等）时是 null，不写 0。 */
  rowCount: number | null;
}

export interface ColumnInfo {
  name: string;
  type: string;
  notNull: boolean;
  primaryKey: boolean;
  defaultValue: string | null;
}

/** `sqlite_master` 的一行 → 表信息。内部表（`sqlite_%`）由调用方决定要不要显示。 */
export function toTableInfo(row: Record<string, unknown>, rowCount: number | null): TableInfo {
  return {
    name: String(row.name ?? ""),
    kind: row.type === "view" ? "view" : "table",
    sql: typeof row.sql === "string" && row.sql ? row.sql : null,
    rowCount,
  };
}

/** `pragma_table_info` 的一行 → 列信息。 */
export function toColumnInfo(row: Record<string, unknown>): ColumnInfo {
  return {
    name: String(row.name ?? ""),
    type: String(row.type ?? "") || "—",
    notNull: Number(row.notnull ?? 0) === 1,
    primaryKey: Number(row.pk ?? 0) > 0,
    defaultValue: row.dflt_value === null || row.dflt_value === undefined ? null : String(row.dflt_value),
  };
}

/** 单元格显示：null 与空串必须看得出区别，长文本截断但标出来。 */
export function formatCell(value: unknown, limit = 160): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "string") {
    if (!value) return "''";
    return value.length > limit ? `${value.slice(0, limit)}…` : value;
  }
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
