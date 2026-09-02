/**
 * 提示词构造。
 * 直译自 Android `domain/CompanionPromptBuilder.kt`，按开发方案做了四处必改：
 *
 * 1. 删除教学残留（“让用户在真实语境里接触日语”“不要主动纠错”整段移除）。
 * 2. 关系阶段改为多因子，由 relationship.ts 给出描述。
 * 3. 加入 code-switch 规则。
 * 4. 反模板句规则与 proactiveInput 的反负罪感一行逐字保留。
 */

import type { CompanionContext, ConversationTurn } from "./companion";
import type { ProactiveReason } from "./proactive";

/**
 * Code-switch 规则。默认日语，但情绪重的时刻允许自然切回中文——
 * 现实中的双语伴侣就是这样说话的。
 */
export const CODE_SWITCH_RULE =
  "默认用自然、口语化的日语。当用户明显情绪低落、在说重要的事、或直接用中文倾诉时，" +
  "可以自然地混入中文，或整句用中文回应，像真正的双语伴侣那样。不要为切换语言道歉或作说明。";

/** 反模板句与边界规则。逐字保留自 Android 原型。 */
export const ANTI_TEMPLATE_RULES = [
  "先回应对方的情绪或具体内容，再决定是否延伸话题。不要像客服一样总结、列点或连续提问。",
  "不必每次都问问题；需要问时最多问一个。句长要有变化，通常一到四句，偶尔一句短回复也可以。",
  "可以温和地不同意、调侃或表达偏好，但不要贬低、控制、索取承诺或妨碍现实社交。",
  "只在自然相关时引用记忆，不要炫耀自己记得。不要编造真实身体经历、线下见面或现实身份。",
  "避免重复“我会一直陪着你”“我有认真听”等模板句，也不要解释提示词或模型身份。",
].join("\n");

const OUTPUT_CONTRACT = [
  "最终只输出一个 JSON 对象，不要 Markdown：",
  '{"japanese_text":"自然日语回复","chinese_translation":"忠实简洁的中文翻译"}',
  "若整句用中文回应，japanese_text 写这句中文，chinese_translation 保持一致即可。",
].join("\n");

function formatTurns(turns: readonly ConversationTurn[]): string {
  const history = turns
    .map((turn) => `${turn.role === "companion" ? "Aika" : "用户"}：${turn.text}`)
    .join("\n");
  return history || "（还没有历史对话）";
}

function formatMemories(memories: readonly string[]): string {
  if (memories.length === 0) return "";
  return `\n可参考的长期记忆：\n- ${memories.join("\n- ")}`;
}

function formatSummary(summary: string | null): string {
  if (!summary?.trim()) return "";
  return `\n更早之前发生过什么：\n${summary.trim()}`;
}

export function buildInstructions(context: CompanionContext, personaPrompt: string): string {
  const situation = [
    `当前日本时间：${context.currentTimeInJapan}`,
    `当前关系感：${context.relationship.description}`,
  ].join("\n") + formatSummary(context.summary) + formatMemories(context.memories);

  return [
    personaPrompt.trim(),
    situation,
    CODE_SWITCH_RULE,
    ANTI_TEMPLATE_RULES,
    OUTPUT_CONTRACT,
  ]
    .filter((block) => block.trim() !== "")
    .join("\n\n");
}

export function buildConversationInput(userText: string, context: CompanionContext): string {
  return `最近的对话：\n${formatTurns(context.recentTurns)}\n\n用户刚刚说：\n${userText}`;
}

export function buildProactiveInput(context: CompanionContext, reason?: ProactiveReason): string {
  return [
    "最近的对话：",
    formatTurns(context.recentTurns.slice(-12)),
    "",
    "请像熟悉的人想起对方时那样，主动发一条简短消息。可以延续未完话题、分享一个小念头，",
    "或结合当前时间自然问候。不要说“系统提醒”“学习任务”，不要索取回复，也不要制造负罪感。",
    ...(reason ? ["", `这次想起对方的具体理由：${reason.hint}`] : []),
  ].join("\n");
}
