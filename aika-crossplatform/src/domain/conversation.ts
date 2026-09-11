import { japanTimeLabel, type CompanionContext, type CompanionReply, type ConversationTurn } from "./companion";
import type { Mood } from "./mood";
import { computeRelationship, deriveRelationshipSignals } from "./relationship";
import { RAW_TURN_WINDOW } from "./summary";
import type { PlaybackStatus } from "./voiceRuntime";

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
  /** 她说这句话时的语气。用户消息不设。 */
  mood?: Mood;
  /** 她挑的表情包 id。清单里没有这个 id 时界面什么都不显示。 */
  sticker?: string;
  /** 运行时关联的用户回合；旧消息没有此字段时仍按旧数据读取。 */
  turnId?: number;
  /**
   * CompanionRuntime 的轮次 id。
   *
   * 与上面的 `turnId` 是两回事，不要合并：`turnId` 是语音回合号（number），
   * 已经落在库里；Runtime 用的是 uuid（string）。改写旧字段的语义会让已有数据
   * 变成垃圾，所以这里新开一个字段，旧消息没有它是正常的，不要回填假值。
   */
  runtimeTurnId?: string;
  /** 这条消息是怎么来的。proactive 用于统计每日主动消息条数。 */
  source?: MessageSource;
  pending?: boolean;
  error?: boolean;
  /** 被打断且已展示的 assistant 片段不能伪装成完整回复。 */
  completion?: "complete" | "interrupted";
  /** 中断时不猜测用户听到了多少；有外部播放进度时才写 played。 */
  playbackStatus?: PlaybackStatus;
}

export type MessageSource = "text" | "voice" | "proactive";

export function formatClockTime(createdAt: number): string {
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(new Date(createdAt));
}

export function userMessage(
  content: string,
  createdAt: number = Date.now(),
  turnId?: number,
): ChatMessage {
  return {
    id: crypto.randomUUID(), role: "user", content, createdAt, time: formatClockTime(createdAt),
    ...(turnId === undefined ? {} : { turnId }),
  };
}

export function companionMessage(
  reply: CompanionReply,
  createdAt: number = Date.now(),
  id: string = crypto.randomUUID(),
  source: MessageSource = "text",
  turnId?: number,
): ChatMessage {
  return {
    id,
    role: "assistant",
    content: reply.japaneseText,
    japaneseText: reply.japaneseText,
    chineseTranslation: reply.chineseTranslation,
    mood: reply.mood,
    ...(reply.sticker ? { sticker: reply.sticker } : {}),
    ...(turnId === undefined ? {} : { turnId }),
    source,
    createdAt,
    time: formatClockTime(createdAt),
  };
}

/**
 * 次级字幕的显示值。空串表示这一条不该有第二层。
 *
 * 模型经常把 replyText 和 translation 返回同一句：提示词的输出契约本来就允许
 * 「整句本来就是中文时两个字段写成一样」，而 openai-compatible 协议不支持
 * json_schema，双语全靠约定。渲染侧只看 showTranslation 开关的结果，就是同一句话
 * 连着显示两遍。
 *
 * 判定只看「是不是同一句」，**不看语言**：纯汉字的日语（「大丈夫」「了解」）在
 * detectLanguage 眼里是 zh，按语言去掉字幕会把真正需要翻译的那几句一起去掉。
 */
export function displayTranslation(message: ChatMessage): string {
  const translation = message.chineseTranslation?.trim() ?? "";
  if (!translation) return "";
  const body = message.japaneseText ?? message.content;
  return sentenceKey(body) === sentenceKey(translation) ? "" : translation;
}

/** 同句比较键。空白、标点和英文大小写的差别不算两句话。 */
function sentenceKey(text: string): string {
  return text.replace(/[\s\p{P}\p{S}]/gu, "").toLowerCase();
}

/** 一次可重跑的失败轮：要删掉哪几行，用哪句原话重投。 */
export interface RetryableTurn {
  /** 该轮在库里留下的全部消息 id，重投前要先删掉。 */
  ids: string[];
  /** 用户当初说的那句话。 */
  text: string;
  /** 原轮来源。语音轮重投时仍标 voice，不伪装成打字。 */
  source: MessageSource;
}

/**
 * 找出失败气泡对应的那一轮。不可重试时返回 null。
 *
 * 为什么要连用户那条一起删：`CompanionRuntime` 在生成前就把用户那句话落库了
 * （「后面生成失败，这一句也不该丢」），而 `submit()` 每轮都新建 id 重新持久化。
 * 只删失败气泡就重投，库里会留下两条一模一样的用户消息。
 *
 * 归组按 `runtimeTurnId`：Runtime 给用户消息写 turn.id，Presenter 给失败气泡写
 * handle.turnId，同一轮的两行天然同号。旧数据没有这个字段，回退到「失败气泡之前
 * 最近的那条用户消息」——这是那些行唯一还能用的线索。
 *
 * 主动消息轮没有用户发言，重投无从谈起，返回 null 让界面不给入口。
 */
export function retryableTurn(
  messages: readonly ChatMessage[],
  failureId: string,
): RetryableTurn | null {
  const index = messages.findIndex((message) => message.id === failureId);
  const failure = index < 0 ? undefined : messages[index];
  if (!failure || failure.role !== "assistant" || !failure.error) return null;

  const sameTurn = failure.runtimeTurnId
    ? messages.filter((message) => message.runtimeTurnId === failure.runtimeTurnId)
    : [failure];
  const asked = sameTurn.find((message) => message.role === "user")
    // 旧数据回退：往前找最近一条用户消息。
    ?? messages.slice(0, index).reverse().find((message) => message.role === "user");
  if (!asked?.content.trim()) return null;

  const ids = [...new Set([...sameTurn.map((message) => message.id), asked.id, failure.id])];
  return { ids, text: asked.content, source: asked.source ?? "text" };
}

/** 送进提示词的历史。Aika 的历史只带日语正文，不带中文翻译，避免占用上下文。 */
export function toCompanionTurns(messages: readonly ChatMessage[]): ConversationTurn[] {
  return messages
    .filter((message) => (
      !message.pending
      && !message.error
      && !(message.role === "assistant" && message.completion === "interrupted")
    ))
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
