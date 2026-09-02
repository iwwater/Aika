/**
 * 陪伴引擎的稳定数据结构。
 * 直译自 Android `domain/CompanionEngine.kt`，关系判定改为多因子（见 relationship.ts）。
 */

import type { RelationshipState } from "./relationship";

export interface CompanionReply {
  japaneseText: string;
  chineseTranslation: string;
}

export type CompanionTurnRole = "user" | "companion";

export interface ConversationTurn {
  role: CompanionTurnRole;
  text: string;
}

export interface CompanionContext {
  recentTurns: ConversationTurn[];
  memories: string[];
  /** 更早对话的滚动摘要；没有更早的对话时为 null。 */
  summary: string | null;
  relationship: RelationshipState;
  currentTimeInJapan: string;
}

export interface CompanionEngine {
  replyTo(userText: string, context: CompanionContext): Promise<CompanionReply>;
  createProactiveMessage(context: CompanionContext): Promise<CompanionReply>;
}

/** 模型被要求返回的结构化字段，不靠换行猜测。 */
export const COMPANION_REPLY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    japanese_text: { type: "string" },
    chinese_translation: { type: "string" },
  },
  required: ["japanese_text", "chinese_translation"],
} as const;

function stripCodeFence(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();
}

function firstJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * 解析模型回复。
 *
 * 容错优先：拿不到结构化字段时，整段文本仍然当作日语正文返回，
 * 而不是抛错让一轮对话直接消失。中文翻译缺失时返回空串，界面据此不显示次级字幕。
 */
export function parseCompanionReply(modelText: string): CompanionReply {
  const trimmed = stripCodeFence(modelText ?? "");
  if (!trimmed) return { japaneseText: "", chineseTranslation: "" };

  const payload = firstJsonObject(trimmed) as Record<string, unknown> | null;
  if (payload) {
    const japanese = typeof payload.japanese_text === "string" ? payload.japanese_text.trim() : "";
    const chinese = typeof payload.chinese_translation === "string" ? payload.chinese_translation.trim() : "";
    if (japanese) return { japaneseText: japanese, chineseTranslation: chinese };
  }

  return { japaneseText: trimmed, chineseTranslation: "" };
}

/** 提示词里的“当前日本时间”。角色生活在日本时区，与用户所在时区无关。 */
export function japanTimeLabel(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now);
}

/** 朗读与字幕主体统一走这里，避免各处重复判断空翻译。 */
export function replyDisplayText(reply: CompanionReply): string {
  return reply.japaneseText || reply.chineseTranslation;
}
