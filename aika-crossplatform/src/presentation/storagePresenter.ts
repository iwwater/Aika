/**
 * 存储浏览页的 Presenter（F8）。
 *
 * 与 React 无关，所以它是这个页面**唯一可测的行为面**（仓库没有 DOM 测试环境）。
 * 判定全在 `domain/sqlConsole.ts`——尤其是只读门禁：**它必须在执行之前拦住**，
 * 组件里一个 if 都不该有。
 *
 * 拿到 `sqlExecutor` 的代码负责自己的边界（存储契约里写着）。这里只读不写：
 * 规划文档 §7 问题 3 的答案是只读，理由见 FE-12 SPEC。
 */

import {
  classifyStatement, toColumnInfo, toResultTable, toTableInfo,
  type ColumnInfo, type SqlResult, type TableInfo,
} from "../domain/sqlConsole";
import type { SqlExecutor } from "../services/memory/sqliteMemoryStore";

export interface StorageViewModel {
  /** 没有 sqlExecutor（浏览器 localStorage 降级）时为 false：页面据此说明白，而不是给一张空表。 */
  available: boolean;
  loading: boolean;
  tables: readonly TableInfo[];
  selectedTable: string | null;
  columns: readonly ColumnInfo[];
  /** 选中表的建表 SQL 原文。 */
  createSql: string | null;
  /** 预览或控制台的结果，共用一块。 */
  result: SqlResult | null;
  /** 控制台里的语句。 */
  query: string;
  /** 上一次执行的语句来自哪里，决定结果区标题。 */
  resultSource: "preview" | "console" | null;
  error: string;
}

export interface StoragePresenter {
  getSnapshot(): StorageViewModel;
  subscribe(listener: () => void): () => void;
  /** 幂等：重复调用只装载一次。 */
  start(): Promise<void>;
  refresh(): Promise<void>;
  selectTable(name: string): Promise<void>;
  setQuery(sql: string): void;
  runQuery(): Promise<void>;
  dispose(): void;
}

export interface StoragePresenterDeps {
  /** 没有 SQL 能力时为 null。 */
  executor: SqlExecutor | null;
  now?: () => number;
  /** 预览一张表时取多少行。 */
  previewLimit?: number;
}

const DEFAULT_PREVIEW_LIMIT = 50;

/** 表名只能是标识符：预览语句里它没法参数化，只能自己把住。 */
const SAFE_NAME = /^[A-Za-z_][A-Za-z0-9_$]*$/;

export function createStoragePresenter(deps: StoragePresenterDeps): StoragePresenter {
  const listeners = new Set<() => void>();
  const now = deps.now ?? (() => Date.now());
  const previewLimit = deps.previewLimit ?? DEFAULT_PREVIEW_LIMIT;
  let disposed = false;
  let started = false;

  let loading = false;
  let tables: TableInfo[] = [];
  let selectedTable: string | null = null;
  let columns: ColumnInfo[] = [];
  let createSql: string | null = null;
  let result: SqlResult | null = null;
  let query = "";
  let resultSource: StorageViewModel["resultSource"] = null;
  let error = "";

  let cached: StorageViewModel | null = null;
  let dirty = true;

  function commit(): void {
    dirty = true;
    if (disposed) return;
    for (const listener of [...listeners]) listener();
  }

  function getSnapshot(): StorageViewModel {
    if (!cached || dirty) {
      cached = Object.freeze({
        available: Boolean(deps.executor),
        loading,
        tables,
        selectedTable,
        columns,
        createSql,
        result,
        query,
        resultSource,
        error,
      });
      dirty = false;
    }
    return cached;
  }

  async function rows(sql: string, bind?: unknown[]): Promise<Record<string, unknown>[]> {
    const executor = deps.executor;
    if (!executor) return [];
    const value = await executor.select<unknown>(sql, bind);
    return Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
  }

  /** 数一张表有多少行。视图或坏表数不出来时返回 null——不写 0，那会看起来像「空表」。 */
  async function countRows(name: string): Promise<number | null> {
    if (!SAFE_NAME.test(name)) return null;
    try {
      const [row] = await rows(`SELECT COUNT(*) AS n FROM "${name}"`);
      const count = Number(row?.n);
      return Number.isFinite(count) ? count : null;
    } catch {
      return null;
    }
  }

  async function loadTables(): Promise<void> {
    if (!deps.executor) {
      commit();
      return;
    }
    loading = true;
    commit();
    try {
      const list = await rows(
        "SELECT name, type, sql FROM sqlite_master WHERE type IN ('table','view') ORDER BY type, name",
      );
      const next: TableInfo[] = [];
      for (const row of list) {
        const name = String(row.name ?? "");
        // sqlite 自己的内部表（sqlite_sequence 等）照样列出来：调试页藏东西没有道理，
        // 但 FTS 的影子表太多，按前缀归到后面由页面决定怎么显示。
        next.push(toTableInfo(row, await countRows(name)));
      }
      tables = next;
      error = "";
    } catch (loadError) {
      error = messageOf(loadError);
    } finally {
      loading = false;
      commit();
    }
  }

  async function selectTable(name: string): Promise<void> {
    if (!deps.executor) return;
    selectedTable = name;
    loading = true;
    commit();
    try {
      // 占位符用 $1：生产走 @tauri-apps/plugin-sql，测试的 node 执行器按同一套映射。
      // notnull 要加引号：它同时是 SQLite 的一个运算符，不引就是语法错误。
      const info = await rows('SELECT name, type, "notnull", pk, dflt_value FROM pragma_table_info($1)', [name]);
      columns = info.map(toColumnInfo);
      createSql = tables.find((table) => table.name === name)?.sql ?? null;
      if (SAFE_NAME.test(name)) {
        const startedAt = now();
        const preview = await rows(`SELECT * FROM "${name}" LIMIT ${previewLimit + 1}`);
        result = toResultTable(preview, now() - startedAt, previewLimit);
        resultSource = "preview";
      } else {
        // 名字不是普通标识符就不预览：这句拼不出安全的 SQL，schema 仍然给。
        result = null;
        resultSource = null;
      }
      error = "";
    } catch (selectError) {
      error = messageOf(selectError);
      result = null;
      resultSource = null;
    } finally {
      loading = false;
      commit();
    }
  }

  return {
    getSnapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async start() {
      if (started || disposed) return;
      started = true;
      await loadTables();
    },

    refresh: loadTables,
    selectTable,

    setQuery(sql) {
      query = sql;
      commit();
    },

    async runQuery() {
      if (!deps.executor) return;
      // 门禁在执行之前：拿到执行器的 select() 照样能跑写语句，拦不住就是真的写进去了。
      const verdict = classifyStatement(query);
      if (!verdict.ok) {
        error = verdict.detail;
        result = null;
        resultSource = "console";
        commit();
        return;
      }
      loading = true;
      commit();
      try {
        const startedAt = now();
        const value = await rows(query);
        result = toResultTable(value, now() - startedAt);
        resultSource = "console";
        error = "";
      } catch (runError) {
        error = messageOf(runError);
        result = null;
        resultSource = "console";
      } finally {
        loading = false;
        commit();
      }
    },

    dispose() {
      disposed = true;
      listeners.clear();
    },
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
