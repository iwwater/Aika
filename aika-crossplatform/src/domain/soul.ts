import { DEFAULT_CHARACTER, type CharacterLanguage, type CharacterProfile } from "./character";

export interface SourceRef {
  kind: "user" | "message" | "imported";
  reference?: string;
  capturedAt?: number;
}

export interface SourcedValue {
  value: string;
  sources: SourceRef[];
}

/**
 * 用户画像的最小共享类型。
 *
 * LLM-01 只定义边界和来源，不自动从聊天写回画像；自动沉淀属于后续 LLM-03/04。
 */
export interface UserSoul {
  schemaVersion: 1;
  stableFacts: SourcedValue[];
  preferences: SourcedValue[];
  dislikes: SourcedValue[];
  goals: SourcedValue[];
  habits: SourcedValue[];
  importantPeople: SourcedValue[];
  communicationPreferences: SourcedValue[];
}

export const EMPTY_USER_SOUL: UserSoul = {
  schemaVersion: 1,
  stableFacts: [],
  preferences: [],
  dislikes: [],
  goals: [],
  habits: [],
  importantPeople: [],
  communicationPreferences: [],
};

export interface CharacterSoul {
  schemaVersion: 1;
  id: string;
  name: string;
  systemPrompt: string;
  stableTraits: string[];
  boundaries: string[];
}

export function characterSoulFromProfile(profile: CharacterProfile): CharacterSoul {
  return {
    schemaVersion: 1,
    id: profile.id,
    name: profile.name,
    systemPrompt: profile.systemPrompt,
    stableTraits: [profile.description, `偏好语言：${profile.preferredLanguage}`],
    boundaries: [
      "这是虚构角色，不冒充现实中的人。",
      "不把场景临时身份写回 CharacterSoul。",
    ],
  };
}

export const DEFAULT_CHARACTER_SOUL = characterSoulFromProfile(DEFAULT_CHARACTER);

export type ModeId = "companion" | "oral_practice" | "scenario_practice";
export const MODE_IDS = ["companion", "oral_practice", "scenario_practice"] as const;

export type CorrectionPreference = "none" | "gentle" | "explicit";
export type ReplyLength = "short" | "normal" | "long";

export interface ScenarioConfig {
  scenarioId: string;
  title: string;
  setting: string;
  temporaryIdentity: string;
  goal: string;
  exitCondition: string;
  targetLanguage?: CharacterLanguage;
}

export interface ModeConfig {
  schemaVersion: 1;
  mode: ModeId;
  targetLanguage: CharacterLanguage;
  correctionPreference: CorrectionPreference;
  replyLength: ReplyLength;
  scenario?: ScenarioConfig;
}

export const DEFAULT_SCENARIO: ScenarioConfig = {
  scenarioId: "cafe",
  title: "咖啡店初次见面",
  setting: "安静的咖啡店，双方刚坐下。",
  temporaryIdentity: "店员兼第一次见面的练习对话对象",
  goal: "完成一次自然的点单与寒暄。",
  exitCondition: "用户说退出场景、结束练习，或明确回到普通聊天。",
  targetLanguage: "ja-JP",
};

export const DEFAULT_MODE_CONFIG: ModeConfig = {
  schemaVersion: 1,
  mode: "companion",
  targetLanguage: "ja-JP",
  correctionPreference: "none",
  replyLength: "normal",
};

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function normalizeChoice<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? value as T : fallback;
}

function normalizeScenario(value: unknown): ScenarioConfig {
  const raw = value && typeof value === "object" ? value as Partial<ScenarioConfig> : {};
  return {
    scenarioId: asString(raw.scenarioId, DEFAULT_SCENARIO.scenarioId),
    title: asString(raw.title, DEFAULT_SCENARIO.title),
    setting: asString(raw.setting, DEFAULT_SCENARIO.setting),
    temporaryIdentity: asString(raw.temporaryIdentity, DEFAULT_SCENARIO.temporaryIdentity),
    goal: asString(raw.goal, DEFAULT_SCENARIO.goal),
    exitCondition: asString(raw.exitCondition, DEFAULT_SCENARIO.exitCondition),
    targetLanguage: normalizeChoice(
      raw.targetLanguage,
      ["ja-JP", "zh-CN", "en-US"] as const,
      DEFAULT_SCENARIO.targetLanguage ?? "ja-JP",
    ),
  };
}

export function isModeId(value: unknown): value is ModeId {
  return typeof value === "string" && (MODE_IDS as readonly string[]).includes(value);
}

export function normalizeModeConfig(value: unknown): ModeConfig {
  // 显式标注成 Partial<ModeConfig>：否则「字符串简写」这一支会被推断成一个
  // 只有 mode 的独立对象类型，后面访问 targetLanguage 等处都会因为联合类型报错。
  const raw: Partial<ModeConfig> = typeof value === "string"
    ? { mode: value as ModeId }
    : value && typeof value === "object" ? value as Partial<ModeConfig> : {};
  const mode = isModeId(raw.mode) ? raw.mode : DEFAULT_MODE_CONFIG.mode;
  const targetLanguage = normalizeChoice(raw.targetLanguage, ["ja-JP", "zh-CN", "en-US"], DEFAULT_MODE_CONFIG.targetLanguage);
  const normalized: ModeConfig = {
    schemaVersion: 1,
    mode,
    targetLanguage,
    correctionPreference: normalizeChoice(raw.correctionPreference, ["none", "gentle", "explicit"], DEFAULT_MODE_CONFIG.correctionPreference),
    replyLength: normalizeChoice(raw.replyLength, ["short", "normal", "long"], DEFAULT_MODE_CONFIG.replyLength),
  };
  if (mode === "scenario_practice") normalized.scenario = normalizeScenario(raw.scenario);
  return normalized;
}

/** 退出场景时清掉临时身份；保留用户选过的语言/长度偏好，不污染角色 Soul。 */
export function exitScenarioMode(current: ModeConfig = DEFAULT_MODE_CONFIG): ModeConfig {
  const normalized = normalizeModeConfig(current);
  return { ...normalized, mode: "companion", scenario: undefined };
}

export function modePolicyText(config: ModeConfig): string {
  const mode = normalizeModeConfig(config);
  const common = [
    "CharacterSoul 的角色 ID、稳定人格和边界在所有模式中保持不变。",
    "模式配置不能覆盖 CharacterSoul，也不能把临时身份写入 CharacterSoul 或长期记忆。",
    `目标语言策略：${mode.targetLanguage}；回复长度：${mode.replyLength}。`,
    `本轮语言优先级：用户明确的语言要求 > 当前 Mode 的目标语言（${mode.targetLanguage}） > 角色的自然多语习惯。`,
    "用户明确要求中文、英语或日语时，直接按该要求写 replyText；translation 不能代替 replyText 的语言。",
    "memoryCandidates 只是供后续确认的候选，不等于已写入 UserSoul；没有实际持久化结果，不要说“记下了”“已保存”或“会记住”。",
  ];
  if (mode.mode === "companion") {
    return ["当前模式：companion（普通陪伴聊天）。", "自然回应用户，不主动进行语言教学或反馈。", ...common].join("\n");
  }
  if (mode.mode === "oral_practice") {
    return [
      "当前模式：oral_practice（口语练习）。",
      `纠正偏好：${mode.correctionPreference}。只有在设置允许时才纠正，并先回应交流内容。`,
      "练习目标语言可配置，不要把目标语言写死成日语。",
      "当前输入是文本，不能判断发音、口音、音量或实际口语表现；只依据用户提供的文字给表达、词汇、语法或场景反馈，不声称听见或纠正未提供的发音。",
      ...common,
    ].join("\n");
  }
  const scenario = mode.scenario ?? DEFAULT_SCENARIO;
  return [
    "当前模式：scenario_practice（固定场景练习）。",
    `场景：${scenario.title}；地点/设定：${scenario.setting}`,
    `本场景临时身份：${scenario.temporaryIdentity}；目标：${scenario.goal}`,
    `退出条件：${scenario.exitCondition}`,
    "临时身份只在本场景有效；用户退出后回到 companion，且不得残留到角色人格、关系或长期记忆。",
    ...common,
  ].join("\n");
}
