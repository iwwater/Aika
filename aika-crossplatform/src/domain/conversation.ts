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

/**
 * 开场白的固定 id。
 *
 * 它是唯一一条**从来不落库**的消息，所以任何删除类操作都要认得它：删掉它只是让
 * 问候语在这次会话里凭空消失，重开又回来。Presenter 与界面共用这一个常量。
 */
export const WELCOME_MESSAGE_ID = "welcome";

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

/** 一轮消息：它在库里留下哪几行，用户当初说了什么。 */
export interface MessageTurn {
  /** 该轮在库里留下的全部消息 id。撤回删这些，重投前也先删这些。 */
  ids: string[];
  /** 用户当初说的那句话。主动消息轮没有用户发言，为空串。 */
  text: string;
  /** 原轮来源。语音轮重投时仍标 voice，不伪装成打字。 */
  source: MessageSource;
}

/** FE-05 的名字保留：可重试的那一轮，形状与 MessageTurn 相同。 */
export type RetryableTurn = MessageTurn;

/**
 * 找出一条消息所属的那一轮。找不到该消息时返回 null。
 *
 * 归组按 `runtimeTurnId`：Runtime 给用户消息写 turn.id，Presenter 给失败气泡写
 * handle.turnId，同一轮的几行天然同号。旧数据没有这个字段，回退到「这条消息之前
 * 最近的那条用户消息」——那些行唯一还能用的线索。
 *
 * 为什么重投前要把用户那条一起删：`CompanionRuntime` 在生成前就把用户那句话落库了
 * （「后面生成失败，这一句也不该丢」），而 `submit()` 每轮都新建 id 重新持久化。
 * 只删 assistant 那条就重投，库里会留下两条一模一样的用户消息。
 */
export function messageTurn(
  messages: readonly ChatMessage[],
  messageId: string,
): MessageTurn | null {
  const index = messages.findIndex((message) => message.id === messageId);
  const target = index < 0 ? undefined : messages[index];
  if (!target) return null;

  const sameTurn = target.runtimeTurnId
    ? messages.filter((message) => message.runtimeTurnId === target.runtimeTurnId)
    : [target];
  const asked = sameTurn.find((message) => message.role === "user")
    // 旧数据回退：往前找最近一条用户消息。
    ?? messages.slice(0, index).reverse().find((message) => message.role === "user");
  const ids = [...new Set([...sameTurn.map((message) => message.id), ...(asked ? [asked.id] : [])])];
  return { ids, text: asked?.content.trim() ? asked.content : "", source: asked?.source ?? target.source ?? "text" };
}

/**
 * 可重试的失败轮。不可重试时返回 null。
 *
 * 主动消息轮没有用户发言，重投无从谈起，返回 null 让界面不给入口。
 */
export function retryableTurn(
  messages: readonly ChatMessage[],
  failureId: string,
): RetryableTurn | null {
  const failure = messages.find((message) => message.id === failureId);
  if (!failure || failure.role !== "assistant" || !failure.error) return null;
  const turn = messageTurn(messages, failureId);
  return turn?.text ? turn : null;
}

/**
 * 可重新生成的那一轮。机制与重试完全相同，区别只在入口长在成功的气泡上。
 *
 * 失败气泡走重试，不在这里出第二个按钮；还在生成中的那条也不给——
 * 要换回复先让这一轮结束，或者取消它。
 */
export function regeneratableTurn(
  messages: readonly ChatMessage[],
  messageId: string,
): MessageTurn | null {
  const target = messages.find((message) => message.id === messageId);
  if (!target || target.role !== "assistant" || target.error || target.pending) return null;
  const turn = messageTurn(messages, messageId);
  return turn?.text ? turn : null;
}

/** 一次回退：从锚点之后删到最新。 */
export interface RewindPlan {
  /** 要删掉的消息 id。锚点自己不在里面——「回到这里」是留下它。 */
  ids: string[];
  /** 锚点的时间戳。摘要要不要标 gap 按它和 coversUntil 比。 */
  anchorAt: number;
}

/**
 * 算出「回到这里」要删掉哪些消息。不可回退时返回 null。
 *
 * 不需要「按时间截断」的存储端口：`listMessages` 返回的是**最近** N 条，
 * 锚点既然在已加载的窗口里，它之后的消息必然也都在窗口里，按 id 删就够。
 *
 * 三种情况不给回退：开场白（从来不落库，而且「回到开场白」等于清空整个对话，
 * 破坏面太大）、锚点之后什么都没有（回退等于什么都不做）、锚点不存在。
 */
export function rewindPlan(
  messages: readonly ChatMessage[],
  anchorId: string,
): RewindPlan | null {
  if (anchorId === WELCOME_MESSAGE_ID) return null;
  const index = messages.findIndex((message) => message.id === anchorId);
  if (index < 0) return null;
  const ids = messages.slice(index + 1)
    .map((message) => message.id)
    .filter((id) => id !== WELCOME_MESSAGE_ID);
  if (!ids.length) return null;
  return { ids, anchorAt: messages[index].createdAt };
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
