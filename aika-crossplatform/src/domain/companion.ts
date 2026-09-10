/**
 * 陪伴引擎的稳定数据结构。
 * 直译自 Android `domain/CompanionEngine.kt`，关系判定改为多因子（见 relationship.ts）。
 */

import { MOODS, normalizeMood, type Mood } from "./mood";
import { DEFAULT_MEMORY_CATEGORY, isMemoryCategory, type MemoryCandidate } from "./memory";
import type { RelationshipState } from "./relationship";

export interface CompanionReply {
  japaneseText: string;
  chineseTranslation: string;
  /** 她说这句话时的语气。认不出来时是 neutral，不会缺。 */
  mood: Mood;
  /** 她挑的表情包 id。没挑、或者编了个清单里没有的名字时不设。 */
  sticker?: string;
  /** LLM-01 的统一回复协议；旧字段保留给现有消息/语音消费者。 */
  schemaVersion?: 1;
  replyText?: string;
  translation?: string;
  memoryCandidates?: MemoryCandidate[];
  actions?: ReplyAction[];
  expression?: string;
  motion?: string;
}

export interface ReplyAction {
  type: "sticker";
  payload: { id: string };
}

export interface ReplyEnvelopeV1 {
  schemaVersion: 1;
  mood: Mood;
  replyText: string;
  translation: string;
  memoryCandidates: MemoryCandidate[];
  actions: ReplyAction[];
  sticker?: string;
  expression?: string;
  motion?: string;
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
    replyText: { type: "string" },
    translation: { type: "string" },
    memoryCandidates: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          category: { type: "string" },
          content: { type: "string" },
        },
        required: ["category", "content"],
      },
    },
    actions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          type: { type: "string", enum: ["sticker"] },
          payload: {
            type: "object",
            additionalProperties: false,
            properties: { id: { type: "string" } },
            required: ["id"],
          },
        },
        required: ["type", "payload"],
      },
    },
  };
  if (!stickerIds.length) {
    return {
      type: "object",
      additionalProperties: false,
      properties: base,
      required: ["mood", "replyText", "translation", "memoryCandidates", "actions"],
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
    required: ["mood", "replyText", "translation", "memoryCandidates", "actions", "sticker"],
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

function normalizeMemoryCandidates(value: unknown): MemoryCandidate[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const content = typeof record.content === "string" ? record.content.trim() : "";
    if (!content) return [];
    const category = isMemoryCategory(record.category) ? record.category : DEFAULT_MEMORY_CATEGORY;
    return [{ category, content }];
  });
}

/** 只保留当前 LLM 已知且没有执行器风险的动作；未知动作永不向下游传递。 */
function normalizeActions(value: unknown, sticker?: string): ReplyAction[] {
  const candidates = Array.isArray(value)
    ? value
    : value && typeof value === "object" ? [value] : [];
  const actions = candidates.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const payload = record.payload && typeof record.payload === "object"
      ? record.payload as Record<string, unknown>
      : record;
    const id = typeof payload.id === "string" ? payload.id.trim() : "";
    return record.type === "sticker" && id ? [{ type: "sticker" as const, payload: { id } }] : [];
  });
  if (actions.length) return actions;
  return sticker ? [{ type: "sticker", payload: { id: sticker } }] : [];
}

function hasOwn(payload: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(payload, key);
}

function normalizeReply(payload: Record<string, unknown>): ReplyEnvelopeV1 | null {
  // canonical 字段一旦存在就锁定，即使值为 null/非 string 也不能静默回退旧字段；
  // 这样 provider 才能把违反协议的回复显式判失败，而不是混用两套正文。
  const replyValue = hasOwn(payload, "replyText")
    ? payload.replyText
    : hasOwn(payload, "reply_text") ? payload.reply_text : payload.japanese_text;
  const translationValue = hasOwn(payload, "translation")
    ? payload.translation
    : payload.chinese_translation;
  if ((hasOwn(payload, "replyText") && typeof replyValue !== "string")
    || (hasOwn(payload, "translation") && typeof translationValue !== "string")) {
    return null;
  }
  const replyText = typeof replyValue === "string" ? replyValue.trim() : "";
  const translation = typeof translationValue === "string" ? translationValue.trim() : "";
  if (!replyText && !translation) return null;
  const sticker = typeof payload.sticker === "string" ? payload.sticker.trim() : "";
  const rawCandidates = hasOwn(payload, "memoryCandidates")
    ? payload.memoryCandidates
    : payload.memory_candidates;
  const rawActions = hasOwn(payload, "actions")
    ? payload.actions
    : hasOwn(payload, "action") ? payload.action : payload.toolCalls;
  return {
    schemaVersion: 1,
    mood: normalizeMood(hasOwn(payload, "mood") ? payload.mood : payload.emotion),
    replyText,
    translation,
    memoryCandidates: normalizeMemoryCandidates(rawCandidates),
    actions: normalizeActions(rawActions, sticker),
    ...(sticker ? { sticker } : {}),
    ...(typeof payload.expression === "string" ? { expression: payload.expression } : {}),
    ...(typeof payload.motion === "string" ? { motion: payload.motion } : {}),
  };
}

export function toCompanionReply(envelope: ReplyEnvelopeV1): CompanionReply {
  return {
    japaneseText: envelope.replyText,
    chineseTranslation: envelope.translation,
    mood: envelope.mood,
    ...(envelope.sticker ? { sticker: envelope.sticker } : {}),
    schemaVersion: 1,
    replyText: envelope.replyText,
    translation: envelope.translation,
    memoryCandidates: envelope.memoryCandidates,
    actions: envelope.actions,
    ...(envelope.expression ? { expression: envelope.expression } : {}),
    ...(envelope.motion ? { motion: envelope.motion } : {}),
  };
}

/**
 * 解析模型回复。
 *
 * 容错优先：拿不到结构化字段时，整段文本仍然当作日语正文返回，
 * 而不是抛错让一轮对话直接消失。中文翻译缺失时返回空串，界面据此不显示次级字幕。
 */
export function parseCompanionReply(modelText: string): CompanionReply {
  const trimmed = stripCodeFence(modelText ?? "");
  if (!trimmed) return toCompanionReply({
    schemaVersion: 1,
    replyText: "",
    translation: "",
    mood: normalizeMood(null),
    memoryCandidates: [],
    actions: [],
  });

  const payload = firstJsonObject(trimmed) as Record<string, unknown> | null;
  if (payload) {
    const envelope = normalizeReply(payload);
    if (envelope) return toCompanionReply(envelope);
    // 看起来像 JSON 但没有可显示正文时显式返回空包，由 provider finish 报错；
    // 不能把畸形对象原样当正文展示。
    return toCompanionReply({
      schemaVersion: 1,
      replyText: "",
      translation: "",
      mood: normalizeMood(payload.mood ?? payload.emotion),
      memoryCandidates: [],
      actions: [],
    });
  }

  // 结构化协议一旦以 JSON object 开头却没有闭合/通过校验，不能把协议残片
  // 当普通正文显示。这样 provider 的 finish() 才能把坏回复显式判失败，
  // 也不会把半截 JSON 落成一条看似成功的消息。
  if (trimmed.startsWith("{")) {
    return toCompanionReply({
      schemaVersion: 1,
      replyText: "",
      translation: "",
      mood: normalizeMood(null),
      memoryCandidates: [],
      actions: [],
    });
  }

  return toCompanionReply({
    schemaVersion: 1,
    replyText: trimmed,
    translation: "",
    mood: normalizeMood(null),
    memoryCandidates: [],
    actions: [],
  });
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
  return reply.replyText || reply.japaneseText || reply.translation || reply.chineseTranslation;
}
