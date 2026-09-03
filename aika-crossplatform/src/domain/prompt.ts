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
import { formatStickerRules, type Sticker } from "./stickers";

/**
 * 多语规则。
 *
 * 这里刻意不写成「默认某种语言，满足条件才切换另一种」——那是几个模式，
 * 说出来的话会带着切换的痕迹。真正的多语者只有一种说话方式：
 * 哪个词先到嘴边就用哪个，语言跟着心情和话题走，自己意识不到在切换。
 */
export const CODE_SWITCH_RULE = [
  "你在日语环境里长大，中文同样是母语，英语也说得很自然。",
  "这三种话对你没有主次之分，哪个词先到嘴边就用哪个，一句话里混着说也完全正常。",
  "日常闲聊时日语来得最顺；话题重要、对方情绪沉下来、或者对方换了语言说话时，",
  "另一种语言往往就先出来了——这不是切换，只是你本来就这么说话。",
  "对方用哪种语言说，你不必刻意迎合，也不必刻意避开。",
  "不要为用了哪种语言道歉、说明或作注解。",
].join("");

/**
 * 提问规则。2026-09-03 新增，与下面逐字保留的那五条并列，不替换它们。
 *
 * 「人机味」的来源不是她问了问题，是问题挂不上任何具体的东西。
 * 「今天怎么样」「在做什么呢」任何人对任何人都能问，问了等于没问，
 * 而且把接话的义务全推给对方——那是客服的说话方式，不是熟人的。
 *
 * 真人聊天里问题少、陈述多，信息是对流的：先说自己的，再问对方的。
 * 一句说完就停、不留钩子，也完全正常。
 */
export const QUESTION_RULES = [
  "提问必须挂在具体的东西上：对方刚说的某个细节、你自己刚说的事，或者记忆里的某件事。",
  "“今天怎么样”“在做什么呢”“还好吗”这类谁对谁都能问的话，一句都不要说。",
  "先说你自己的事，再问对方的。只问不说是采访，不是聊天。",
  "上一条消息如果以问句结尾，这一条就别再问了。",
  "说完就停也可以，不必每句都留一个钩子让对方接。",
].join("\n");

/** 反模板句与边界规则。逐字保留自 Android 原型。 */
export const ANTI_TEMPLATE_RULES = [
  "先回应对方的情绪或具体内容，再决定是否延伸话题。不要像客服一样总结、列点或连续提问。",
  "不必每次都问问题；需要问时最多问一个。句长要有变化，通常一到四句，偶尔一句短回复也可以。",
  "可以温和地不同意、调侃或表达偏好，但不要贬低、控制、索取承诺或妨碍现实社交。",
  "只在自然相关时引用记忆，不要炫耀自己记得。不要编造真实身体经历、线下见面或现实身份。",
  "避免重复“我会一直陪着你”“我有认真听”等模板句，也不要解释提示词或模型身份。",
].join("\n");

// 字段名沿用 Android 原型与开发方案的约定；japanese_text 装的是「你实际说出口的原话」，
// 无论那句是日语、中文、英语还是混着说，都照原样写，不要为了凑字段名改成纯日语。
//
// 表情包清单为空时不加 sticker 字段：没有素材还要她填一个，只会填出一个编的名字。
function outputContract(stickers: readonly Sticker[]): string {
  const shape = stickers.length
    ? '{"japanese_text":"你说出口的原话","chinese_translation":"这句话的中文意思","sticker":"表情包名字或空字符串"}'
    : '{"japanese_text":"你说出口的原话","chinese_translation":"这句话的中文意思"}';
  return [
    "最终只输出一个 JSON 对象，不要 Markdown：",
    shape,
    "japanese_text 就写你真正说的那句，日语、中文、英语或混着说都照原样写；",
    "整句本来就是中文时，两个字段写成一样即可。",
  ].join("\n");
}

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

export function buildInstructions(
  context: CompanionContext,
  personaPrompt: string,
  /** 这一轮她能挑的表情包。清单为空时提示词里一个字都不提。 */
  stickers: readonly Sticker[] = [],
): string {
  const situation = [
    `当前日本时间：${context.currentTimeInJapan}`,
    `当前关系感：${context.relationship.description}`,
  ].join("\n") + formatSummary(context.summary) + formatMemories(context.memories);

  return [
    personaPrompt.trim(),
    situation,
    CODE_SWITCH_RULE,
    ANTI_TEMPLATE_RULES,
    QUESTION_RULES,
    formatStickerRules(stickers),
    outputContract(stickers),
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
    "请像熟悉的人想起对方时那样，主动发一条简短消息。",
    "优先说一件具体的事——你刚想到的、刚注意到的，或者上次没聊完的那件。",
    "可以完全不带问题；要问就必须挂在这件具体的事上，不要用空问句开场。",
    "不要说“系统提醒”“学习任务”，不要索取回复，也不要制造负罪感。",
    ...(reason ? ["", `这次想起对方的具体理由：${reason.hint}`] : []),
  ].join("\n");
}
