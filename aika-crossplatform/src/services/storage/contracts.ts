import type { ChatMessage } from "../../domain/conversation";
import type { MemoryRecord, MemoryStatus } from "../../domain/memory";
import type { SessionSummary } from "../../domain/summary";

/**
 * 持久化边界。
 *
 * 桌面版走 SQLite（`sqliteStorage`），浏览器里跑 `npm run dev` 时退回 localStorage
 * （`localStorage` 实现），两者行为一致，界面不需要知道自己在哪个上面跑。
 *
 * API Key 不在这里：它走 secretStore，落在 DPAPI 加密的 secrets.json，不与业务数据同表。
 */
export interface AikaStorage {
  readonly kind: "sqlite" | "local";

  /** 最近 limit 条消息，按时间正序。 */
  listMessages(limit: number): Promise<ChatMessage[]>;
  appendMessage(message: ChatMessage): Promise<void>;
  /** 全部消息的时间戳，用于多因子关系状态。 */
  listMessageTimestamps(): Promise<number[]>;
  countMessagesSince(since: number): Promise<number>;
  countProactiveSince(since: number): Promise<number>;
  clearMessages(): Promise<void>;

  listMemories(): Promise<MemoryRecord[]>;
  addMemories(records: readonly MemoryRecord[]): Promise<void>;
  setMemoryStatus(id: string, status: MemoryStatus): Promise<void>;
  deleteMemory(id: string): Promise<void>;

  latestSummary(): Promise<SessionSummary | null>;
  saveSummary(summary: SessionSummary): Promise<void>;

  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string): Promise<void>;
}

export const SETTING_KEYS = {
  provider: "provider",
  proactive: "proactive",
  proactiveLastSentAt: "proactive.lastSentAt",
  proactiveLastReason: "proactive.lastReason",
  memoryExtraction: "memory.extraction",
  voiceBackend: "voice.backend",
  whisperEndpoint: "voice.whisperEndpoint",
} as const;
