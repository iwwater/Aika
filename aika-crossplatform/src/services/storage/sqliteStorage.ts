import Database from "@tauri-apps/plugin-sql";
import { formatClockTime, type ChatMessage, type MessageSource } from "../../domain/conversation";
import { isMemoryCategory, type MemoryRecord } from "../../domain/memory";
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
     sticker TEXT
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
     created_at INTEGER NOT NULL
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
    source: row.source as MessageSource,
    createdAt: row.created_at,
    time: formatClockTime(row.created_at),
    error: row.is_error === 1,
  };
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

export async function createSqliteStorage(): Promise<AikaStorage> {
  const db = await Database.load(DB_URL);
  for (const statement of SCHEMA) await db.execute(statement);
  for (const statement of MIGRATIONS) {
    try {
      await db.execute(statement);
    } catch {
      // 列已经在了。这是加列的正常路径，不是故障。
    }
  }

  return {
    kind: "sqlite",

    async listMessages(limit) {
      const rows = await db.select<MessageRow[]>(
        "SELECT * FROM messages ORDER BY created_at DESC, rowid DESC LIMIT $1",
        [limit],
      );
      return rows.reverse().map(toMessage);
    },

    async appendMessage(message) {
      await db.execute(
        `INSERT OR REPLACE INTO messages
           (id, role, source, content, japanese_text, chinese_translation, created_at, is_error, sticker)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
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
        ],
      );
    },

    async listMessageTimestamps() {
      const rows = await db.select<{ created_at: number }[]>(
        "SELECT created_at FROM messages WHERE is_error = 0 ORDER BY created_at",
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

    async latestSummary() {
      const rows = await db.select<SummaryRow[]>(
        "SELECT * FROM summaries ORDER BY covers_until DESC LIMIT 1",
      );
      const row = rows[0];
      return row
        ? { id: row.id, content: row.content, coversUntil: row.covers_until, createdAt: row.created_at }
        : null;
    },

    async saveSummary(summary) {
      await db.execute(
        "INSERT INTO summaries (content, covers_until, created_at) VALUES ($1, $2, $3)",
        [summary.content, summary.coversUntil, summary.createdAt],
      );
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
