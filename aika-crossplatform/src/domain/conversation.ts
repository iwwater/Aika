import { japanTimeLabel, type CompanionContext, type CompanionReply, type ConversationTurn } from "./companion";
import { computeRelationship, deriveRelationshipSignals } from "./relationship";

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
  pending?: boolean;
  error?: boolean;
}

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
): ChatMessage {
  return {
    id,
    role: "assistant",
    content: reply.japaneseText,
    japaneseText: reply.japaneseText,
    chineseTranslation: reply.chineseTranslation,
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

/** 组装一轮请求需要的全部上下文。记忆来源在 M1 接入 SQLite 后替换。 */
export function buildCompanionContext(
  messages: readonly ChatMessage[],
  memories: readonly string[] = [],
  now: number = Date.now(),
  recentTurnLimit = 16,
): CompanionContext {
  const usable = messages.filter((message) => !message.pending && !message.error);
  return {
    recentTurns: toCompanionTurns(usable.slice(-recentTurnLimit)),
    memories: [...memories],
    relationship: computeRelationship(deriveRelationshipSignals(usable.map((message) => message.createdAt), now)),
    currentTimeInJapan: japanTimeLabel(new Date(now)),
  };
}
