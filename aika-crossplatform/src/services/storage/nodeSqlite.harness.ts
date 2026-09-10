import { DatabaseSync } from "node:sqlite";
import type { SqlExecutor } from "../memory/sqliteMemoryStore";

/**
 * 用 Node 内置 SQLite 当 `SqlExecutor`。
 *
 * **仅供测试使用，不进任何生产装配。** 它存在的理由是：让生产的
 * `createSqliteStorage` / `createSqliteMemoryStore` 在真实 SQLite 引擎上跑
 * ——真的建表、真的开事务、真的跑 FTS5 MATCH——而不是对着假执行器断言 SQL 文本。
 *
 * 它能证明的只有「SQL 与 SQLite 引擎行为一致」，不能代替 Tauri 里
 * @tauri-apps/plugin-sql 的接入验证。
 */
export class NodeSqliteExecutor implements SqlExecutor {
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

export function openMemorySqlite(): { db: DatabaseSync; executor: NodeSqliteExecutor } {
  const db = new DatabaseSync(":memory:");
  return { db, executor: new NodeSqliteExecutor(db) };
}
