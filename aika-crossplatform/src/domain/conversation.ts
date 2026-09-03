import { japanTimeLabel, type CompanionContext, type CompanionReply, type ConversationTurn } from "./companion";
import { computeRelationship, deriveRelationshipSignals } from "./relationship";
import { RAW_TURN_WINDOW } from "./summary";

export type ConversationRole = "user" | "assistant";

export interface ChatTurn {
  role: ConversationRole;
  content: string;
}

export interface ChatMessage extends ChatTurn {
  id: string;
  /** 毫秒时间戳。关系状态按日历天统计，必须持久化，不能只留 HH:mm。 */
  createdAt: number;
  /** 展示用的 HH:mm，由 createdAt 派生后缓存。 */
  time: string;
  /** Aika 的日语正文；用户消息不设。整句中文回应时这里就是那句中文。 */
  japaneseText?: string;
  /** 次级字幕。模型没给翻译时为空，界面据此不显示第二层。 */
  chineseTranslation?: string;
  /** 她挑的表情包 id。清单里没有这个 id 时界面什么都不显示。 */
  sticker?: string;
  /** 这条消息是怎么来的。proactive 用于统计每日主动消息条数。 */
  source?: MessageSource;
  pending?: boolean;
  error?: boolean;
}

export type MessageSource = "text" | "voice" | "proactive";

export function formatClockTime(createdAt: number): string {
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(new Date(createdAt));
}

export function userMessage(content: string, createdAt: number = Date.now()): ChatMessage {
  return { id: crypto.randomUUID(), role: "user", content, createdAt, time: formatClockTime(createdAt) };
}

export function companionMessage(
  reply: CompanionReply,
  createdAt: number = Date.now(),
  id: string = crypto.randomUUID(),
  source: MessageSource = "text",
): ChatMessage {
  return {
    id,
    role: "assistant",
    content: reply.japaneseText,
    japaneseText: reply.japaneseText,
    chineseTranslation: reply.chineseTranslation,
    ...(reply.sticker ? { sticker: reply.sticker } : {}),
    source,
    createdAt,
    time: formatClockTime(createdAt),
  };
}

/** 送进提示词的历史。Aika 的历史只带日语正文，不带中文翻译，避免占用上下文。 */
export function toCompanionTurns(messages: readonly ChatMessage[]): ConversationTurn[] {
  return messages
    .filter((message) => !message.pending && !message.error)
    .map((message) => ({
      role: message.role === "assistant" ? "companion" as const : "user" as const,
      text: message.role === "assistant" ? message.japaneseText ?? message.content : message.content,
    }));
}

/**
 * 组装一轮请求需要的全部上下文。
 * 近 recentTurnLimit 轮走原文，更早的靠 summary；关系状态由消息时间戳现算，不冗余存储。
 */
export function buildCompanionContext(options: {
  messages: readonly ChatMessage[];
  memories?: readonly string[];
  summary?: string | null;
  /** 全部消息的时间戳。分页加载时它比 messages 更全，缺省则退回 messages 自身。 */
  timestamps?: readonly number[];
  now?: number;
  recentTurnLimit?: number;
}): CompanionContext {
  const now = options.now ?? Date.now();
  const usable = options.messages.filter((message) => !message.pending && !message.error);
  const timestamps = options.timestamps ?? usable.map((message) => message.createdAt);
  return {
    recentTurns: toCompanionTurns(usable.slice(-(options.recentTurnLimit ?? RAW_TURN_WINDOW))),
    memories: [...(options.memories ?? [])],
    summary: options.summary ?? null,
    relationship: computeRelationship(deriveRelationshipSignals(timestamps, now)),
    currentTimeInJapan: japanTimeLabel(new Date(now)),
  };
}
