import type { ChatMessage } from "../../domain/conversation";
import type { MemoryRecord, MemoryStatus } from "../../domain/memory";
import type { SessionSummary } from "../../domain/summary";
import { browserBackend, createLocalMemoryStore } from "../memory/localMemoryStore";
import type { AikaStorage } from "./contracts";

/**
 * 浏览器回退实现。
 *
 * `npm run dev` 在普通浏览器里没有 SQLite，用它保证界面照样能跑；
 * 桌面正式运行一律走 sqliteStorage。行为与 SQLite 版保持一致，只是慢且没有索引。
 */
const KEYS = {
  messages: "aika.messages.v1",
  memories: "aika.memories.v1",
  summaries: "aika.summaries.v1",
  settings: "aika.settings.v1",
};

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown, throwOnError = false) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    if (throwOnError) throw error;
    // 写不进去就算了：这是开发期回退，不该让界面崩掉。
  }
}

export function createLocalStorage(): AikaStorage {
  return {
    kind: "local",
    // 浏览器降级：整份快照一次替换，写失败就抛错，旧快照不动。
    memoryV2: createLocalMemoryStore(browserBackend()),

    async listMessages(limit) {
      return read<ChatMessage[]>(KEYS.messages, []).slice(-limit);
    },

    async appendMessage(message) {
      const messages = read<ChatMessage[]>(KEYS.messages, []).filter((item) => item.id !== message.id);
      write(KEYS.messages, [...messages, message].sort((a, b) => a.createdAt - b.createdAt));
    },

    async listMessageTimestamps() {
      return read<ChatMessage[]>(KEYS.messages, [])
        .filter((message) => !message.error)
        .map((message) => message.createdAt);
    },

    async countMessagesSince(since) {
      return read<ChatMessage[]>(KEYS.messages, []).filter((message) => message.createdAt >= since).length;
    },

    async countProactiveSince(since) {
      return read<ChatMessage[]>(KEYS.messages, [])
        .filter((message) => message.source === "proactive" && message.createdAt >= since).length;
    },

    async deleteMessages(ids) {
      if (!ids.length) return;
      const doomed = new Set(ids);
      write(KEYS.messages, read<ChatMessage[]>(KEYS.messages, []).filter((message) => !doomed.has(message.id)));
    },

    async clearMessages() {
      write(KEYS.messages, []);
      write(KEYS.summaries, []);
    },

    async listMemories() {
      return read<MemoryRecord[]>(KEYS.memories, []);
    },

    async addMemories(records) {
      const existing = read<MemoryRecord[]>(KEYS.memories, []);
      const ids = new Set(records.map((record) => record.id));
      write(KEYS.memories, [...existing.filter((item) => !ids.has(item.id)), ...records]);
    },

    async setMemoryStatus(id: string, status: MemoryStatus) {
      const memories = read<MemoryRecord[]>(KEYS.memories, []);
      write(
        KEYS.memories,
        memories.map((memory) => (memory.id === id ? { ...memory, status, updatedAt: Date.now() } : memory)),
      );
    },

    async deleteMemory(id) {
      write(KEYS.memories, read<MemoryRecord[]>(KEYS.memories, []).filter((memory) => memory.id !== id));
    },

    async latestSummary() {
      const summaries = read<SessionSummary[]>(KEYS.summaries, []);
      return summaries.length ? summaries[summaries.length - 1] : null;
    },

    async saveSummary(summary) {
      write(KEYS.summaries, [...read<SessionSummary[]>(KEYS.summaries, []), summary]);
    },

    async deleteSummaries() {
      write(KEYS.summaries, []);
    },

    async getSetting(key) {
      return read<Record<string, string>>(KEYS.settings, {})[key] ?? null;
    },

    async setSetting(key, value) {
      // ModeStore 依赖这个 Promise 判断“保存是否成功”；设置不能静默吞掉
      // quota/security 错误，否则 UI 会确认一个重载后消失的模式。
      write(KEYS.settings, { ...read<Record<string, string>>(KEYS.settings, {}), [key]: value }, true);
    },
  };
}
