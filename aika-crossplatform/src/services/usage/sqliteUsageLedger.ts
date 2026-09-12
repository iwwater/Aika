import {
  DEFAULT_USAGE_RETENTION_DAYS, USAGE_QUERY_DEFAULT_LIMIT, USAGE_LEGACY_SCOPE,
  type UsageLedgerPage, type UsageLedgerQuery, type UsageRecordV1,
} from "../../domain/usageLedger";
import type { SqlExecutor } from "../memory/sqliteMemoryStore";
import type { UsageLedgerStore } from "./contracts";

/**
 * 用量台账的 SQLite 落盘（LLM-12）。与内存实现同一套语义；差别是可以跨重启恢复。
 *
 * 形状理由与 trace_events 相同：可索引的维度单独成列（scope/purpose/provider/
 * started_at 是查询与隔离的依据），整条记录另存一份 JSON——记录字段还会长，
 * 一字段一列的话每次都要迁移。payload 里不含正文/密钥/完整 URL（LLM-12 契约），
 * 所以整段 JSON 落盘没有脱敏缺口。
 */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS usage_records (
     id TEXT PRIMARY KEY,
     logical_request_id TEXT NOT NULL,
     turn_id TEXT,
     scope TEXT,
     purpose TEXT NOT NULL,
     provider_id TEXT NOT NULL,
     protocol TEXT NOT NULL,
     model TEXT NOT NULL,
     started_at INTEGER NOT NULL,
     ended_at INTEGER,
     status TEXT NOT NULL,
     payload TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_usage_started ON usage_records (started_at)`,
];

export const DEFAULT_USAGE_SWEEP_INTERVAL_MS = 60_000;

interface UsageRow {
  payload: string;
}

export interface SqliteUsageLedgerOptions {
  clock?: () => number;
  retentionDays?: number;
  sweepIntervalMs?: number;
}

export async function createSqliteUsageLedger(
  db: SqlExecutor,
  options: SqliteUsageLedgerOptions = {},
): Promise<UsageLedgerStore> {
  for (const statement of SCHEMA) await db.execute(statement);

  const clock = options.clock ?? (() => Date.now());
  const retentionMs = Math.max(1, options.retentionDays ?? DEFAULT_USAGE_RETENTION_DAYS) * 86_400_000;
  const sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_USAGE_SWEEP_INTERVAL_MS;
  let lastSweptAt = 0;

  function parse(row: UsageRow): UsageRecordV1 | null {
    try {
      const record = JSON.parse(row.payload) as UsageRecordV1;
      // 主键列与 payload 必须对得上，错行不如丢行。
      return record && record.id ? record : null;
    } catch {
      return null;
    }
  }

  async function write(record: UsageRecordV1): Promise<void> {
    await db.execute(
      `INSERT OR REPLACE INTO usage_records
         (id, logical_request_id, turn_id, scope, purpose, provider_id, protocol, model,
          started_at, ended_at, status, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        record.id, record.logicalRequestId, record.turnId ?? null, record.scope ?? null,
        record.purpose, record.providerId, record.protocol, record.model,
        record.startedAt, record.endedAt ?? null, record.status, JSON.stringify(record),
      ],
    );
    // 清理顺带做，不另起定时器（与 trace 落盘同一套路）。
    const now = clock();
    if (now - lastSweptAt < sweepIntervalMs) return;
    lastSweptAt = now;
    await db.execute("DELETE FROM usage_records WHERE started_at < $1", [now - retentionMs]);
  }

  return {
    async upsert(record) {
      await write(record);
    },

    async query(query: UsageLedgerQuery = {}): Promise<UsageLedgerPage> {
      const limit = Math.max(1, query.limit ?? USAGE_QUERY_DEFAULT_LIMIT);
      const clauses: string[] = [];
      const values: unknown[] = [];
      const bind = (value: unknown) => {
        values.push(value);
        return `$${values.length}`;
      };

      if (query.scope === USAGE_LEGACY_SCOPE) clauses.push("scope IS NULL");
      else if (query.scope !== undefined) clauses.push(`scope = ${bind(query.scope)}`);
      if (query.purpose !== undefined) clauses.push(`purpose = ${bind(query.purpose)}`);
      if (query.providerId !== undefined) clauses.push(`provider_id = ${bind(query.providerId)}`);
      if (query.model !== undefined) clauses.push(`model = ${bind(query.model)}`);
      if (query.since !== undefined) clauses.push(`started_at >= ${bind(query.since)}`);
      if (query.until !== undefined) clauses.push(`started_at <= ${bind(query.until)}`);
      if (query.cursor) {
        // cursor 由本实现的 nextCursor 发出；解不开就当没有，让调用方从头翻。
        const decoded = decodeCursor(query.cursor);
        if (decoded) {
          clauses.push(
            `(started_at < ${bind(decoded.startedAt)} OR (started_at = ${bind(decoded.startedAt)} AND id < ${bind(decoded.id)}))`,
          );
        }
      }

      const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
      // 固定顺序 + 多取一行探有没有下一页；顺序不稳定的话 cursor 分页就无从谈起。
      const rows = await db.select<UsageRow[]>(
        `SELECT payload FROM usage_records${where}
         ORDER BY started_at DESC, id DESC
         LIMIT ${bind(limit + 1)}`,
        values,
      );

      const records = rows.flatMap((row) => {
        const record = parse(row);
        return record ? [record] : [];
      });
      const truncated = records.length > limit;
      const page = truncated ? records.slice(0, limit) : records;
      const last = page[page.length - 1];
      return {
        records: page,
        nextCursor: truncated && last ? encodeCursor(last) : null,
        truncated,
      };
    },
  };
}

function encodeCursor(record: UsageRecordV1): string {
  return btoa(`${record.startedAt}:${encodeURIComponent(record.id)}`);
}

function decodeCursor(cursor: string): { startedAt: number; id: string } | null {
  try {
    const raw = atob(cursor);
    const split = raw.indexOf(":");
    if (split < 0) return null;
    const startedAt = Number(raw.slice(0, split));
    const id = decodeURIComponent(raw.slice(split + 1));
    if (!Number.isFinite(startedAt) || !id) return null;
    return { startedAt, id };
  } catch {
    return null;
  }
}
