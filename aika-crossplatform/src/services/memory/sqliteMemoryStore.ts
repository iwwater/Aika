/**
 * SQLite 版记忆存储（FTS5）。
 *
 * 记忆表与 FTS 索引必须同生共死，所以读写都走显式事务：
 * BEGIN → 改 memories_v2 → 同步 memory_fts → COMMIT，任一步失败就 ROLLBACK。
 * 索引和内容不一致比没有索引更糟——检索会静默丢东西。
 *
 * 迁移版本写在设置表最后更新：只有整批数据都写进去了才算这次迁移完成，
 * 中途失败时旧数据仍在，重跑即可，不会留半截。
 *
 * **分词器是 trigram，不是 unicode61。** 实测（SQLite 3.45）：unicode61 会把
 * 一整句连续汉字当成一个 token，「喝咖啡只喝浅烘焙」只能整串命中，
 * 检索「咖啡」「浅烘焙」全部落空；trigram 支持 3 字符以上的子串命中，
 * 但 2 字词（「咖啡」「通勤」）仍然召回不到。所以 FTS 在这里只是**候选加速**，
 * 真正决定结果的仍是应用层 BM25；候选为空时由 repository 回退全量扫描。
 */

import type { MemoryRecordV2 } from "../../domain/memory";
import {
  MEMORY_SCHEMA_VERSION, emptySnapshot,
  type MemorySnapshot, type MemorySuppression, type MemoryV2Store,
} from "./memoryStore";

/** 普通表与索引。FTS 建不出来时这些仍必须建好，否则记忆整个不可用。 */
export const MEMORY_V2_TABLES = [
  `CREATE TABLE IF NOT EXISTS memories_v2 (
     id TEXT PRIMARY KEY,
     type TEXT NOT NULL,
     content TEXT NOT NULL,
     source_message_ids TEXT NOT NULL DEFAULT '[]',
     source_kind TEXT NOT NULL DEFAULT 'messages',
     status TEXT NOT NULL DEFAULT 'candidate',
     confidence REAL,
     importance REAL NOT NULL DEFAULT 0.5,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     last_confirmed_at INTEGER,
     last_accessed_at INTEGER,
     valid_from INTEGER,
     valid_until INTEGER,
     supersedes_id TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_memories_v2_status ON memories_v2 (status)`,
  `CREATE INDEX IF NOT EXISTS idx_memories_v2_updated_at ON memories_v2 (updated_at)`,
  `CREATE TABLE IF NOT EXISTS memory_suppressions (
     id TEXT PRIMARY KEY,
     content_hash TEXT NOT NULL,
     source_message_ids TEXT NOT NULL DEFAULT '[]',
     created_at INTEGER NOT NULL
   )`,
] as const;

/**
 * FTS 索引单独一组：trigram 才能对中文/日文做 3 字以上子串命中，
 * unicode61 会把整句连续汉字当成一个 token（实测见报告）。
 * 某些 SQLite 构建没编译 FTS5，这时索引建不出来也必须继续启动——
 * 记忆本身照常读写，检索回退全量扫描。
 */
export const MEMORY_V2_FTS = [
  `CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5 (
     id UNINDEXED,
     content,
     tokenize = 'trigram'
   )`,
] as const;

/** 方便测试与外部检查：全部结构语句。 */
export const MEMORY_V2_SCHEMA = [...MEMORY_V2_TABLES, ...MEMORY_V2_FTS] as const;

export const MEMORY_MIGRATION_SETTING_KEY = "memory.migrationVersion";

/** 最小数据库接口：够用即可，便于注入假库做事务测试。 */
export interface SqlExecutor {
  execute(query: string, bindValues?: unknown[]): Promise<unknown>;
  select<T>(query: string, bindValues?: unknown[]): Promise<T>;
}

interface MemoryRow {
  id: string;
  type: string;
  content: string;
  source_message_ids: string | null;
  source_kind: string | null;
  status: string | null;
  confidence: number | null;
  importance: number | null;
  created_at: number;
  updated_at: number;
  last_confirmed_at: number | null;
  last_accessed_at: number | null;
  valid_from: number | null;
  valid_until: number | null;
  supersedes_id: string | null;
}

interface SuppressionRow {
  id: string;
  content_hash: string;
  source_message_ids: string | null;
  created_at: number;
}

function parseIds(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function toRecord(row: MemoryRow): MemoryRecordV2 {
  return {
    schemaVersion: MEMORY_SCHEMA_VERSION,
    id: row.id,
    type: (["fact", "preference", "event", "goal", "relationship"] as const).includes(row.type as never)
      ? row.type as MemoryRecordV2["type"]
      : "fact",
    content: row.content,
    sourceMessageIds: parseIds(row.source_message_ids),
    sourceKind: (["messages", "legacy", "userEdit"] as const).includes(row.source_kind as never)
      ? row.source_kind as MemoryRecordV2["sourceKind"]
      : "messages",
    status: (["candidate", "confirmed", "superseded"] as const).includes(row.status as never)
      ? row.status as MemoryRecordV2["status"]
      : "candidate",
    confidence: typeof row.confidence === "number" ? row.confidence : null,
    importance: typeof row.importance === "number" ? row.importance : 0.5,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastConfirmedAt: row.last_confirmed_at,
    lastAccessedAt: row.last_accessed_at,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    ...(row.supersedes_id ? { supersedesId: row.supersedes_id } : {}),
  };
}

/**
 * 建表 + 建索引。
 *
 * 普通表失败必须让调用方知道（记忆存不了是硬故障）；FTS 建不出来只降级：
 * 返回 `{ fts: false }`，检索走全量扫描，功能不受影响。
 */
export async function ensureMemorySchema(db: SqlExecutor): Promise<{ fts: boolean }> {
  for (const statement of MEMORY_V2_TABLES) {
    await db.execute(statement);
  }
  try {
    for (const statement of MEMORY_V2_FTS) {
      await db.execute(statement);
    }
    return { fts: true };
  } catch {
    return { fts: false };
  }
}

/**
 * 把一句话翻成 FTS5 查询。
 *
 * 拉丁词按整词给（trigram 支持子串），CJK 连续段展开成所有 3-gram 用 OR 连接：
 * 「上个周末他去了哪里」→ 上个周 OR 个周末 OR … 只要任一片段命中就召回，
 * 召回后由 BM25 决定排序。2 字词不产生 3-gram，这里直接返回空串，
 * 由 repository 回退全量扫描——宁可慢一点，也不能因为分词器局限漏掉记忆。
 */
export function ftsQueryOf(text: string, limit = 24): string {
  const terms: string[] = [];
  for (const match of text.toLowerCase().matchAll(/[a-z0-9]{3,}/g)) terms.push(match[0]);
  const runs = text.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g) ?? [];
  for (const run of runs) {
    for (let index = 0; index + 3 <= run.length; index += 1) terms.push(run.slice(index, index + 3));
  }
  const unique = [...new Set(terms)].slice(0, limit);
  if (!unique.length) return "";
  return unique.map((term) => `"${term.replace(/"/g, '""')}"`).join(" OR ");
}

/** 用 FTS 召回候选 id。查询无法构造时返回空数组，调用方据此回退全量。 */
export async function searchMemoryIds(db: SqlExecutor, text: string, limit = 200): Promise<string[]> {
  const term = ftsQueryOf(text);
  if (!term) return [];
  const rows = await db.select<Array<{ id: string }>>(
    "SELECT id FROM memory_fts WHERE memory_fts MATCH $1 LIMIT $2",
    [term, limit],
  );
  return rows.map((row) => row.id);
}

export interface SqliteMemoryStoreOptions {
  /** FTS 索引是否可用。不可用时跳过索引写入，检索交由全量扫描兜底。 */
  fts?: boolean;
}

export function createSqliteMemoryStore(db: SqlExecutor, options: SqliteMemoryStoreOptions = {}): MemoryV2Store {
  const ftsEnabled = options.fts ?? true;
  return {
    async searchIds(text: string): Promise<string[]> {
      if (!ftsEnabled) return [];
      try {
        return await searchMemoryIds(db, text);
      } catch {
        // 索引缺失或查询语法不被支持：交给全量兜底，不要让检索整体失败。
        return [];
      }
    },

    async load(): Promise<MemorySnapshot> {
      const [records, suppressions, versionRows] = await Promise.all([
        db.select<MemoryRow[]>("SELECT * FROM memories_v2"),
        db.select<SuppressionRow[]>("SELECT * FROM memory_suppressions"),
        db.select<{ value: string }[]>("SELECT value FROM settings WHERE key = $1", [MEMORY_MIGRATION_SETTING_KEY]),
      ]);
      const version = Number(versionRows[0]?.value ?? 0);
      return {
        schemaVersion: MEMORY_SCHEMA_VERSION,
        records: records.map(toRecord),
        suppressions: suppressions.map((row) => ({
          id: row.id,
          contentHash: row.content_hash,
          sourceMessageIds: parseIds(row.source_message_ids),
          createdAt: row.created_at,
        })),
        migrationVersion: Number.isFinite(version) ? version : 0,
      };
    },

    async save(snapshot: MemorySnapshot): Promise<void> {
      await db.execute("BEGIN");
      try {
        await db.execute("DELETE FROM memories_v2");
        if (ftsEnabled) await db.execute("DELETE FROM memory_fts");
        await db.execute("DELETE FROM memory_suppressions");

        for (const record of snapshot.records) {
          await db.execute(
            `INSERT INTO memories_v2
               (id, type, content, source_message_ids, source_kind, status, confidence, importance,
                created_at, updated_at, last_confirmed_at, last_accessed_at, valid_from, valid_until, supersedes_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
            [
              record.id,
              record.type,
              record.content,
              JSON.stringify(record.sourceMessageIds),
              record.sourceKind,
              record.status,
              record.confidence,
              record.importance,
              record.createdAt,
              record.updatedAt,
              record.lastConfirmedAt,
              record.lastAccessedAt,
              record.validFrom,
              record.validUntil,
              record.supersedesId ?? null,
            ],
          );
          // 索引与内容同一事务：任何一步失败一起回滚。
          if (ftsEnabled) {
            await db.execute("INSERT INTO memory_fts (id, content) VALUES ($1, $2)", [record.id, record.content]);
          }
        }

        for (const item of snapshot.suppressions as MemorySuppression[]) {
          await db.execute(
            "INSERT INTO memory_suppressions (id, content_hash, source_message_ids, created_at) VALUES ($1,$2,$3,$4)",
            [item.id, item.contentHash, JSON.stringify(item.sourceMessageIds), item.createdAt],
          );
        }

        await db.execute(
          "INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
          [MEMORY_MIGRATION_SETTING_KEY, String(snapshot.migrationVersion)],
        );

        await db.execute("COMMIT");
      } catch (error) {
        await db.execute("ROLLBACK").catch(() => undefined);
        throw error;
      }
    },
  };
}

export { emptySnapshot };
