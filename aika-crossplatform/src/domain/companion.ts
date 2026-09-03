/**
 * 陪伴引擎的稳定数据结构。
 * 直译自 Android `domain/CompanionEngine.kt`，关系判定改为多因子（见 relationship.ts）。
 */

import { MOODS, normalizeMood, type Mood } from "./mood";
import type { RelationshipState } from "./relationship";

export interface CompanionReply {
  japaneseText: string;
  chineseTranslation: string;
  /** 她说这句话时的语气。认不出来时是 neutral，不会缺。 */
  mood: Mood;
  /** 她挑的表情包 id。没挑、或者编了个清单里没有的名字时不设。 */
  sticker?: string;
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

/**
 * 模型被要求返回的结构化字段，不靠换行猜测。
 *
 * **mood 排在最前面，这不是随手排的顺序。** 流式时第一句话可能在整段写完之前
 * 就出声了，语气排在后面就等于拿不到——朗读参数得在第一句开口前定下来。
 *
 * 表情包清单为空时**不加 sticker 字段**：没有素材还要她填一个字段，
 * 只会得到一个她自己编出来的名字。strict 模式下每个属性都必须列进 required，
 * 所以「可选」是靠 enum 里的空串表达的，不是靠省略字段。
 */
export function companionReplySchema(stickerIds: readonly string[] = []) {
  const base = {
    // 枚举而不是自由字符串：她因此编不出词表以外的语气，Live2D 那边不用兜底。
    mood: { type: "string", enum: [...MOODS] },
    japanese_text: { type: "string" },
    chinese_translation: { type: "string" },
  };
  if (!stickerIds.length) {
    return {
      type: "object",
      additionalProperties: false,
      properties: base,
      required: ["mood", "japanese_text", "chinese_translation"],
    };
  }
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      ...base,
      // 枚举里带一个空串：这一轮不发表情包。有了它她就编不出清单以外的名字。
      sticker: { type: "string", enum: [...stickerIds, ""] },
    },
    required: ["mood", "japanese_text", "chinese_translation", "sticker"],
  };
}

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
  if (!trimmed) return { japaneseText: "", chineseTranslation: "", mood: normalizeMood(null) };

  const payload = firstJsonObject(trimmed) as Record<string, unknown> | null;
  if (payload) {
    const japanese = typeof payload.japanese_text === "string" ? payload.japanese_text.trim() : "";
    const chinese = typeof payload.chinese_translation === "string" ? payload.chinese_translation.trim() : "";
    const sticker = typeof payload.sticker === "string" ? payload.sticker.trim() : "";
    // id 是不是真的存在由 resolveSticker 说了算，这里只负责把字段取出来。
    if (japanese) {
      return {
        japaneseText: japanese,
        chineseTranslation: chinese,
        // 不支持结构化输出的协议可能整个字段都没有，认不出来一律 neutral。
        mood: normalizeMood(payload.mood),
        ...(sticker ? { sticker } : {}),
      };
    }
  }

  return { japaneseText: trimmed, chineseTranslation: "", mood: normalizeMood(null) };
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
