import {
  compareUsageRecords, DEFAULT_USAGE_RETENTION_DAYS, USAGE_QUERY_DEFAULT_LIMIT, USAGE_LEGACY_SCOPE,
  type UsageLedgerPage, type UsageLedgerQuery, type UsageRecordV1,
} from "../../domain/usageLedger";
import type { UsageLedgerStore } from "./contracts";

/**
 * 浏览器临时台账。与 SQLite 实现提供**同一套读写语义**（LLM-12-C）：
 * 幂等 upsert、固定顺序、cursor 分页、保留期清理——差别只有持久性：
 * 页面一关就没了，这本来就是「临时存储」的如实含义。
 */

const MAX_RECORDS = 10_000;

export interface MemoryUsageLedgerOptions {
  clock?: () => number;
  retentionDays?: number;
  /** 清理节流：别每写一条都全表扫一遍。 */
  sweepIntervalMs?: number;
  capacity?: number;
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

export function createMemoryUsageLedger(options: MemoryUsageLedgerOptions = {}): UsageLedgerStore {
  const records = new Map<string, UsageRecordV1>();
  const clock = options.clock ?? (() => Date.now());
  const retentionMs = Math.max(1, options.retentionDays ?? DEFAULT_USAGE_RETENTION_DAYS) * 86_400_000;
  const sweepIntervalMs = options.sweepIntervalMs ?? 60_000;
  const capacity = Math.max(1, options.capacity ?? MAX_RECORDS);
  let lastSweptAt = 0;

  function sweep(now: number): void {
    if (now - lastSweptAt < sweepIntervalMs) return;
    lastSweptAt = now;
    const cutoff = now - retentionMs;
    for (const [id, record] of records) {
      if (record.startedAt < cutoff) records.delete(id);
    }
  }

  function evictOverflow(): void {
    while (records.size > capacity) {
      let oldest: UsageRecordV1 | null = null;
      for (const record of records.values()) {
        if (!oldest || compareUsageRecords(record, oldest) < 0) oldest = record;
      }
      if (!oldest) return;
      records.delete(oldest.id);
    }
  }

  function scopeClause(record: UsageRecordV1, scope: string): boolean {
    return scope === USAGE_LEGACY_SCOPE ? record.scope === undefined : record.scope === scope;
  }

  return {
    async upsert(record) {
      records.set(record.id, { ...record });
      const now = clock();
      sweep(now);
      evictOverflow();
    },

    async query(query: UsageLedgerQuery = {}): Promise<UsageLedgerPage> {
      const limit = Math.max(1, query.limit ?? USAGE_QUERY_DEFAULT_LIMIT);
      const cursor = query.cursor ? decodeCursor(query.cursor) : null;

      const matched = [...records.values()]
        .filter((record) => (query.scope === undefined || scopeClause(record, query.scope))
          && (query.purpose === undefined || record.purpose === query.purpose)
          && (query.providerId === undefined || record.providerId === query.providerId)
          && (query.model === undefined || record.model === query.model)
          && (query.since === undefined || record.startedAt >= query.since)
          && (query.until === undefined || record.startedAt <= query.until))
        .sort(compareUsageRecords);

      const after = matched.filter((record) => {
        if (!cursor) return true;
        if (record.startedAt !== cursor.startedAt) return record.startedAt < cursor.startedAt;
        return record.id < cursor.id;
      });

      const page = after.slice(0, limit);
      const truncated = after.length > limit;
      const last = page[page.length - 1];
      return {
        records: page.map((record) => ({ ...record })),
        nextCursor: truncated && last ? encodeCursor(last) : null,
        truncated,
      };
    },
  };
}
