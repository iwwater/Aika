import type { ChatMessage } from "../../domain/conversation";
import type { MemoryRecord, MemoryStatus } from "../../domain/memory";
import type { SessionSummary } from "../../domain/summary";
import type { MemoryV2Store } from "../memory/memoryStore";

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

  /**
   * LLM-03 记忆 V2 端口。
   *
   * 可选：老实现与测试 fake 不提供它，调用方必须能退回 V1 的
   * `listMemories/addMemories/...`。桌面端与浏览器端都会提供。
   */
  readonly memoryV2?: MemoryV2Store;

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
  /**
   * 让已有摘要整体失效（LLM-03 删除记忆时用）。
   *
   * 摘要没有可用的消息溯源，删掉某条记忆后无法只摘掉其中一句，
   * 因此保守地整段作废，下一轮再压缩一次。老实现可以不提供。
   */
  deleteSummaries?(): Promise<void>;

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
  mode: "llm.mode",
  /**
   * CORE-03 迁移期用过 `core.orchestrator = legacy | kernel`。CORE-06 删除旧编排后
   * 这个 key 不再被读写；旧库里残留的值会被当作普通未知设置忽略，不报错、不迁移。
   */
} as const;
