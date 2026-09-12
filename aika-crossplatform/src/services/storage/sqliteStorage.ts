import Database from "@tauri-apps/plugin-sql";
import { formatClockTime, type ChatMessage, type MessageSource } from "../../domain/conversation";
import { isMemoryCategory, type MemoryRecord } from "../../domain/memory";
import { normalizeMood } from "../../domain/mood";
import { createSqliteMemoryStore, ensureMemorySchema, type SqlExecutor } from "../memory/sqliteMemoryStore";
import type { AikaStorage } from "./contracts";

/**
 * SQLite 持久化。记忆就是产品本身，所以它必须落盘，而不是待在 localStorage 里。
 *
 * 建表用 CREATE TABLE IF NOT EXISTS，幂等，不引入额外的迁移框架。
 * 后续加列时往 SCHEMA 里追加一条 ALTER TABLE ... 并自行容错即可。
 */
const DB_URL = "sqlite:aika.db";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS messages (
     id TEXT PRIMARY KEY,
     role TEXT NOT NULL,
     source TEXT NOT NULL DEFAULT 'text',
     content TEXT NOT NULL,
     japanese_text TEXT,
     chinese_translation TEXT,
     created_at INTEGER NOT NULL,
     is_error INTEGER NOT NULL DEFAULT 0,
     sticker TEXT,
     mood TEXT,
     turn_id INTEGER,
     runtime_turn_id TEXT,
     completion_status TEXT NOT NULL DEFAULT 'complete',
     playback_status TEXT,
     conversation_id TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages (created_at)`,
  `CREATE TABLE IF NOT EXISTS memories (
     id TEXT PRIMARY KEY,
     category TEXT NOT NULL,
     content TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'pending',
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS summaries (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     content TEXT NOT NULL,
     covers_until INTEGER NOT NULL,
     created_at INTEGER NOT NULL,
     conversation_id TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS settings (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
];

/**
 * 加列的地方。SQLite 的 ALTER TABLE 没有 IF NOT EXISTS，
 * 老库执行一次就成功、新库会直接报「duplicate column」——所以这里逐条 try 掉。
 */
const MIGRATIONS = [
  "ALTER TABLE messages ADD COLUMN sticker TEXT",
  "ALTER TABLE messages ADD COLUMN mood TEXT",
  "ALTER TABLE messages ADD COLUMN turn_id INTEGER",
  "ALTER TABLE messages ADD COLUMN completion_status TEXT NOT NULL DEFAULT 'complete'",
  "ALTER TABLE messages ADD COLUMN playback_status TEXT",
  "ALTER TABLE messages ADD COLUMN runtime_turn_id TEXT",
  // RT-02 会话 scope：NULL 即 legacy 本地会话，可回退。
  "ALTER TABLE messages ADD COLUMN conversation_id TEXT",
  "ALTER TABLE summaries ADD COLUMN conversation_id TEXT",
];

interface MessageRow {
  id: string;
  role: string;
  source: string;
  content: string;
  japanese_text: string | null;
  chinese_translation: string | null;
  created_at: number;
  is_error: number;
  sticker: string | null;
  mood: string | null;
  turn_id: number | null;
  runtime_turn_id: string | null;
  completion_status: string | null;
  playback_status: string | null;
  conversation_id: string | null;
}

interface MemoryRow {
  id: string;
  category: string;
  content: string;
  status: string;
  created_at: number;
  updated_at: number;
}

interface SummaryRow {
  id: number;
  content: string;
  covers_until: number;
  conversation_id: string | null;
  created_at: number;
}

function toMessage(row: MessageRow): ChatMessage {
  return {
    id: row.id,
    role: row.role === "assistant" ? "assistant" : "user",
    content: row.content,
    japaneseText: row.japanese_text ?? undefined,
    chineseTranslation: row.chinese_translation ?? undefined,
    sticker: row.sticker ?? undefined,
    mood: row.mood ? normalizeMood(row.mood) : undefined,
    turnId: row.turn_id ?? undefined,
    runtimeTurnId: row.runtime_turn_id ?? undefined,
    ...(row.completion_status === "interrupted" ? { completion: "interrupted" as const } : {}),
    playbackStatus: row.playback_status === "played" ? "played" : undefined,
    source: row.source as MessageSource,
    // NULL 即 legacy 本地会话：读出时归一到 local，调用方拿到的归属总是明确的。
    conversationId: row.conversation_id ?? "local",
    createdAt: row.created_at,
    time: formatClockTime(row.created_at),
    error: row.is_error === 1,
  };
}

/**
 * RT-02 的 scope 匹配谓词：目标 scope 是 local 时同时匹配 NULL（legacy 行），
 * 其它 scope 只精确匹配。这样旧数据永远只归属本地会话，不会泄漏给外部主体。
 */
function scopeMatch(column: string, conversationId: string): string {
  if (conversationId === "local") {
    return `(${column} IS NULL OR ${column} = 'local')`;
  }
  return `${column} = '${conversationId.replace(/'/g, "''")}'`;
}

function toMemory(row: MemoryRow): MemoryRecord {
  return {
    id: row.id,
    category: isMemoryCategory(row.category) ? row.category : "日常",
    content: row.content,
    status: row.status === "confirmed" ? "confirmed" : "pending",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * @param executor 注入 SQL 执行器。生产不传，走 Tauri 的 plugin-sql；
 * 端口一致性用例包传 node:sqlite 执行器，让**同一份生产代码**在真实 SQLite 上跑。
 * SQL、表结构与迁移逻辑一字未改。
 */
export async function createSqliteStorage(executor?: SqlExecutor): Promise<AikaStorage> {
  const db = executor ?? await Database.load(DB_URL);
  for (const statement of SCHEMA) await db.execute(statement);
  for (const statement of MIGRATIONS) {
    try {
      await db.execute(statement);
    } catch {
      // 列已经在了。这是加列的正常路径，不是故障。
    }
  }

  // 记忆 V2 表与 FTS 索引。FTS 建不出来时降级为全量检索，不影响记忆读写，
  // 所以这里只需要拿到「索引有没有」，不需要让整个存储启动失败。
  const { fts } = await ensureMemorySchema(db);

  return {
    kind: "sqlite",
    memoryV2: createSqliteMemoryStore(db, { fts }),
    // Trace 落盘等「自带表」的消费者从这里拿执行器，各自建表、各自清理。
    sqlExecutor: db,

    async listMessages(limit, scope) {
      // scope 过滤（RT-02）：local 归属同时匹配旧数据的 NULL（可回退，不丢历史）。
      const scopeClause = scope ? " WHERE " + scopeMatch("conversation_id", scope.conversationId) : "";
      const rows = await db.select<MessageRow[]>(
        `SELECT * FROM messages${scopeClause} ORDER BY created_at DESC, rowid DESC LIMIT $1`,
        [limit],
      );
      return rows.reverse().map(toMessage);
    },

    async appendMessage(message) {
      await db.execute(
        `INSERT OR REPLACE INTO messages
           (id, role, source, content, japanese_text, chinese_translation, created_at, is_error, sticker, mood,
            turn_id, runtime_turn_id, completion_status, playback_status, conversation_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [
          message.id,
          message.role,
          message.source ?? "text",
          message.content,
          message.japaneseText ?? null,
          message.chineseTranslation ?? null,
          message.createdAt,
          message.error ? 1 : 0,
          message.sticker ?? null,
          message.mood ?? null,
          message.turnId ?? null,
          message.runtimeTurnId ?? null,
          message.completion ?? "complete",
          message.playbackStatus ?? null,
          message.conversationId ?? null,
        ],
      );
    },

    async listMessageTimestamps(scope) {
      const scopeClause = scope ? " AND " + scopeMatch("conversation_id", scope.conversationId) : "";
      const rows = await db.select<{ created_at: number }[]>(
        `SELECT created_at FROM messages WHERE is_error = 0${scopeClause} ORDER BY created_at`,
      );
      return rows.map((row) => row.created_at);
    },

    async countMessagesSince(since) {
      const rows = await db.select<{ total: number }[]>(
        "SELECT COUNT(*) AS total FROM messages WHERE created_at >= $1",
        [since],
      );
      return rows[0]?.total ?? 0;
    },

    async countProactiveSince(since) {
      const rows = await db.select<{ total: number }[]>(
        "SELECT COUNT(*) AS total FROM messages WHERE source = 'proactive' AND created_at >= $1",
        [since],
      );
      return rows[0]?.total ?? 0;
    },

    async deleteMessages(ids) {
      if (!ids.length) return;
      // 占位符按个数现拼：plugin-sql 不支持把数组绑成一个 IN 参数。
      const placeholders = ids.map((_, index) => `$${index + 1}`).join(", ");
      await db.execute(`DELETE FROM messages WHERE id IN (${placeholders})`, [...ids]);
    },

    async clearMessages() {
      await db.execute("DELETE FROM messages");
      await db.execute("DELETE FROM summaries");
    },

    async listMemories() {
      const rows = await db.select<MemoryRow[]>("SELECT * FROM memories ORDER BY created_at");
      return rows.map(toMemory);
    },

    async addMemories(records) {
      for (const record of records) {
        await db.execute(
          `INSERT OR REPLACE INTO memories (id, category, content, status, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [record.id, record.category, record.content, record.status, record.createdAt, record.updatedAt],
        );
      }
    },

    async setMemoryStatus(id, status) {
      await db.execute("UPDATE memories SET status = $1, updated_at = $2 WHERE id = $3", [
        status,
        Date.now(),
        id,
      ]);
    },

    async deleteMemory(id) {
      await db.execute("DELETE FROM memories WHERE id = $1", [id]);
    },

    async latestSummary(scope) {
      const scopeClause = scope ? " WHERE " + scopeMatch("conversation_id", scope.conversationId) : "";
      const rows = await db.select<SummaryRow[]>(
        `SELECT * FROM summaries${scopeClause} ORDER BY covers_until DESC LIMIT 1`,
      );
      const row = rows[0];
      return row
        ? {
          id: row.id, content: row.content, coversUntil: row.covers_until,
          createdAt: row.created_at, conversationId: row.conversation_id ?? undefined,
        }
        : null;
    },

    async saveSummary(summary) {
      await db.execute(
        "INSERT INTO summaries (content, covers_until, created_at, conversation_id) VALUES ($1, $2, $3, $4)",
        [summary.content, summary.coversUntil, summary.createdAt, summary.conversationId ?? null],
      );
    },

    async deleteSummaries() {
      await db.execute("DELETE FROM summaries");
    },

    async getSetting(key) {
      const rows = await db.select<{ value: string }[]>(
        "SELECT value FROM settings WHERE key = $1",
        [key],
      );
      return rows[0]?.value ?? null;
    },

    async setSetting(key, value) {
      await db.execute(
        "INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [key, value],
      );
    },
  };
}
