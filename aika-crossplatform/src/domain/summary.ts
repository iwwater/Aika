/**
 * 滚动会话摘要。
 *
 * 长期对话既不能丢上下文，也不能把整段历史塞进每次请求：
 * 近 RAW_TURN_WINDOW 轮保留原文，更早的压成一段摘要跟着走。
 */

export interface SessionSummary {
  id?: number;
  content: string;
  /** 这段摘要覆盖到哪条消息的时间戳为止（含）。 */
  coversUntil: number;
  createdAt: number;
}

/** 提示词里保留原文的最近消息条数。 */
export const RAW_TURN_WINDOW = 16;

/** 摘要之后累积多少条新消息就再压缩一次。 */
export const SUMMARY_TRIGGER_COUNT = 40;

/** 一次摘要最多读多少条原文，避免把整部历史塞进抽取请求。 */
export const SUMMARY_INPUT_LIMIT = 80;

export function shouldSummarize(messagesSinceLastSummary: number): boolean {
  return messagesSinceLastSummary >= SUMMARY_TRIGGER_COUNT;
}

/**
 * 摘要的作用是让她记得发生过什么，不是给用户看的报告。
 * 明确要求不要评价用户，也不要写「用户应该……」这类东西。
 */
export const SUMMARY_INSTRUCTIONS = [
  "把下面这段对话压缩成一段第三人称记录，供 Aika 之后回忆使用。",
  "只写发生了什么、对方说了什么、当时的心情和还没聊完的话题。",
  "不要评价对方，不要给建议，不要写「用户应该」，不要提到「摘要」「记录」这些词。",
  "控制在 200 字以内，用中文写。",
].join("\n");

export function buildSummaryInput(previousSummary: string | null, transcript: string): string {
  const earlier = previousSummary
    ? `更早之前的记录：\n${previousSummary}\n\n`
    : "";
  return `${earlier}这一段对话：\n${transcript}`;
}
