/**
 * 主动消息。
 *
 * 频率闸门直译自 Android `domain/ProactivePolicy.kt`，阈值与判定逻辑保持一致；
 * 触发理由按开发方案 M2 做了多样化。
 *
 * 设计红线：这里只回答「能不能发」和「因为什么想起对方」，
 * 不做任何基于用户沉默时长的加压。理由文本里禁止出现「好久不见」「你怎么不理我」这类话术，
 * 久别触发时明确要求不要提起间隔本身。
 */

import type { ConversationTurn } from "./companion";

export const MAX_DAILY_MESSAGES = 6;
export const MIN_INTERVAL_MS = 90 * 60 * 1000;

export interface ProactiveSettings {
  /** 用户可一键完全关闭。 */
  enabled: boolean;
  quietStartHour: number;
  quietEndHour: number;
}

export const DEFAULT_PROACTIVE_SETTINGS: ProactiveSettings = {
  enabled: false,
  quietStartHour: 23,
  quietEndHour: 8,
};

export interface ProactiveGateInput {
  nowMillis: number;
  hour: number;
  quietStartHour: number;
  quietEndHour: number;
  messagesToday: number;
  lastMessageAt: number | null;
  enabled?: boolean;
}

export function isQuietHour(hour: number, quietStartHour: number, quietEndHour: number): boolean {
  return quietStartHour < quietEndHour
    ? hour >= quietStartHour && hour < quietEndHour
    : hour >= quietStartHour || hour < quietEndHour;
}

export function canSend(input: ProactiveGateInput): boolean {
  if (input.enabled === false) return false;
  if (isQuietHour(input.hour, input.quietStartHour, input.quietEndHour)) return false;
  if (input.messagesToday >= MAX_DAILY_MESSAGES) return false;
  if (input.lastMessageAt !== null && input.nowMillis - input.lastMessageAt < MIN_INTERVAL_MS) return false;
  return true;
}

export type ProactiveReasonKind =
  | "unfinished-topic"
  | "user-plan"
  | "time-semantics"
  | "memory-date"
  | "small-thought";

export interface ProactiveReason {
  kind: ProactiveReasonKind;
  /** 写进 proactive 输入的一句具体理由。越具体，越不像「在做什么呢」。 */
  hint: string;
}

export interface ProactiveReasonInput {
  recentTurns: readonly ConversationTurn[];
  memories: readonly string[];
  now: Date;
  hoursSinceLastUserMessage: number | null;
  /** 上一次用过的理由类型，用来避免连着两次同一个角度。 */
  lastReasonKind: ProactiveReasonKind | null;
}

const PLAN_PATTERNS = [
  /明天|後天|后天|来週|來週|下周|下週|週末|周末|今度|再来/,
  /打算|准备|準備|计划|計画|予定|要去|想去|考试|試験|面接|面试|出差|旅行/,
];

const DATE_PATTERN = /(\d{1,2}\s*月\s*\d{1,2}\s*日)|(\d{4}-\d{2}-\d{2})|(生日|誕生日|纪念日|記念日)/;

const SHARED_TAIL = "不要索取回复，也不要制造负罪感。";

function lastUserTurn(turns: readonly ConversationTurn[]): string | null {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    if (turns[index].role === "user") return turns[index].text;
  }
  return null;
}

function endedOnCompanionTurn(turns: readonly ConversationTurn[]): boolean {
  return turns.length > 0 && turns[turns.length - 1].role === "companion";
}

function excerpt(text: string, limit = 40): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > limit ? `${clean.slice(0, limit)}…` : clean;
}

function timeSemantics(now: Date, hoursSinceLastUserMessage: number | null): string | null {
  const day = now.getDay();
  const hour = now.getHours();

  // 久别：可以作为触发，但绝不能把间隔说出口。
  if (hoursSinceLastUserMessage !== null && hoursSinceLastUserMessage >= 72) {
    return "距离上次说话已经过了一段时间。**不要提起这段间隔**，也不要问对方去哪了，就像平常那样开口。";
  }
  if (day === 5 && hour >= 18) return "现在是周五晚上。";
  if (hour >= 23 || hour < 3) return "现在是深夜，对方还醒着。语气要更轻。";
  if (day === 1 && hour < 11) return "现在是周一早上。";
  if (hour >= 6 && hour < 9) return "现在是清晨。";
  return null;
}

function collectReasons(input: ProactiveReasonInput): ProactiveReason[] {
  const reasons: ProactiveReason[] = [];
  const recentUser = lastUserTurn(input.recentTurns);

  if (recentUser && endedOnCompanionTurn(input.recentTurns)) {
    reasons.push({
      kind: "unfinished-topic",
      hint: `上次聊到「${excerpt(recentUser)}」就停下了。可以自然地接着说你自己后来的想法，不要追问对方当时为什么没回。`,
    });
  }

  const plan = input.recentTurns
    .filter((turn) => turn.role === "user")
    .reverse()
    .find((turn) => PLAN_PATTERNS.every((pattern) => pattern.test(turn.text)));
  if (plan) {
    reasons.push({
      kind: "user-plan",
      hint: `对方提过一件要做的事：「${excerpt(plan.text)}」。可以顺口说一句你自己想到的念头，不要追问进展。`,
    });
  }

  const timeHint = timeSemantics(input.now, input.hoursSinceLastUserMessage);
  if (timeHint) {
    reasons.push({ kind: "time-semantics", hint: `${timeHint}结合这个时间自然地开口。` });
  }

  const datedMemory = input.memories.find((memory) => DATE_PATTERN.test(memory));
  if (datedMemory) {
    reasons.push({
      kind: "memory-date",
      hint: `记忆里有一条和日期有关：「${excerpt(datedMemory)}」。如果时机自然就提一句，不要炫耀自己记得。`,
    });
  }

  reasons.push({
    kind: "small-thought",
    hint: "没有特别的事，只是忽然想起对方。分享一个属于你自己的小念头就好。",
  });

  return reasons;
}

/**
 * 选一个触发理由。
 * 优先挑与上次不同的角度——连着两条「现在是深夜」比没有主动消息更让人想关掉它。
 */
export function chooseProactiveReason(input: ProactiveReasonInput): ProactiveReason {
  const reasons = collectReasons(input);
  const fresh = reasons.find((reason) => reason.kind !== input.lastReasonKind);
  const chosen = fresh ?? reasons[0];
  return { ...chosen, hint: `${chosen.hint}${SHARED_TAIL}` };
}
