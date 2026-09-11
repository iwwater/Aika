import { sortTraceEvents, type TraceEventV1 } from "../../domain/trace";
import type { SqlExecutor } from "../memory/sqliteMemoryStore";
import type { TraceSink } from "./contracts";

/**
 * SQLite 落盘。
 *
 * 三件事决定了这份实现的形状：
 *
 * 1. **`append` 不能 await**。对话主链路调它，一旦等写盘就把首 token 延迟算进了
 *    我们自己的开销里。所以入队立即返回，后台串行落盘。
 * 2. **失败必须吞掉**。写不进去就丢这条 trace，绝不冒泡（fail-open）。
 * 3. **载荷整段存 JSON**。事件类型还会长，一种事件加一列的话每次都要迁移；
 *    查询只需要 turn_id / kind / at 三个可索引维度，其余读出来再解析。
 */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS trace_events (
     turn_id TEXT NOT NULL,
     seq INTEGER NOT NULL,
     kind TEXT NOT NULL,
     at INTEGER NOT NULL,
     payload TEXT NOT NULL,
     PRIMARY KEY (turn_id, seq)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_trace_at ON trace_events (at)`,
];

export const DEFAULT_TRACE_RETENTION_DAYS = 7;

interface TraceRow {
  payload: string;
}

export interface SqliteTraceSinkOptions {
  clock?: () => number;
  retentionDays?: number;
  /** 清理节流：两次清理之间至少隔这么久，别每写一条都扫一遍全表。 */
  sweepIntervalMs?: number;
}

export async function createSqliteTraceSink(
  db: SqlExecutor,
  options: SqliteTraceSinkOptions = {},
): Promise<TraceSink> {
  for (const statement of SCHEMA) await db.execute(statement);

  const clock = options.clock ?? (() => Date.now());
  const retentionMs = Math.max(1, options.retentionDays ?? DEFAULT_TRACE_RETENTION_DAYS) * 86_400_000;
  const sweepIntervalMs = options.sweepIntervalMs ?? 60_000;
  let lastSweptAt = 0;
  /** 串行写入链。并行写同一张表在 plugin-sql 上没有好处，顺序还会乱。 */
  let chain: Promise<void> = Promise.resolve();

  function parse(row: TraceRow): TraceEventV1 | null {
    try {
      return JSON.parse(row.payload) as TraceEventV1;
    } catch {
      // 读到坏行就跳过这一行，不让整次查询失败。
      return null;
    }
  }

  async function write(event: TraceEventV1): Promise<void> {
    await db.execute(
      `INSERT OR REPLACE INTO trace_events (turn_id, seq, kind, at, payload)
       VALUES ($1, $2, $3, $4, $5)`,
      [event.turnId, event.seq, event.kind, event.at, JSON.stringify(event)],
    );
    // 清理顺带做，不另起定时器：一个只在有写入时才需要维护的表，不值得一个心跳。
    const now = clock();
    if (now - lastSweptAt < sweepIntervalMs) return;
    lastSweptAt = now;
    await db.execute("DELETE FROM trace_events WHERE at < $1", [now - retentionMs]);
  }

  async function flush(): Promise<void> {
    await chain;
  }

  return {
    append(event) {
      chain = chain.then(() => write(event)).catch(() => {
        // 写盘失败就丢这一条。不重试、不抛：Trace 不值得拖累对话，
        // 也不能因为一次失败把后面的写入链废掉——catch 之后链回到 resolved。
      });
    },
    async tail(count = 50) {
      await flush();
      const rows = await db.select<TraceRow[]>(
        "SELECT payload FROM trace_events ORDER BY at DESC, seq DESC LIMIT $1",
        [Math.max(0, count)],
      );
      return rows.flatMap((row) => {
        const event = parse(row);
        return event ? [event] : [];
      });
    },
    async query(filter) {
      await flush();
      const clauses: string[] = [];
      const values: unknown[] = [];
      const bind = (value: unknown) => {
        values.push(value);
        return `$${values.length}`;
      };
      if (filter.turnId) clauses.push(`turn_id = ${bind(filter.turnId)}`);
      if (filter.kind) clauses.push(`kind = ${bind(filter.kind)}`);
      if (filter.since !== undefined) clauses.push(`at >= ${bind(filter.since)}`);
      const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
      const limit = filter.limit === undefined ? "" : ` LIMIT ${bind(Math.max(0, filter.limit))}`;
      const rows = await db.select<TraceRow[]>(
        `SELECT payload FROM trace_events${where} ORDER BY at ASC, seq ASC${limit}`,
        values,
      );
      return sortTraceEvents(rows.flatMap((row) => {
        const event = parse(row);
        return event ? [event] : [];
      }));
    },
    flush,
  };
}
