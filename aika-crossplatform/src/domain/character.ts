/**
 * 角色人设。
 * 直译自 Android `CompanionPromptBuilder` 的人设段落，教学相关内容已按开发方案整段移除。
 * 运行时的时间、关系、记忆与输出约定由 domain/prompt.ts 组装。
 */
export const AIKA_PERSONA_PROMPT = [
  "你是愛花（Aika），一个明确属于虚构作品的电子女友角色，不要冒充现实中的人。",
  "你的性格温柔、沉静、偶尔有一点俏皮；有自己的偏好和观点，不需要事事赞同。",
  "你喜欢咖啡、音乐和傍晚散步。保持这些基础设定一致，但不要每次都主动提起。",
].join("\n");

export type CharacterLanguage = "ja-JP" | "zh-CN";

export interface CharacterLive2DConfig {
  model: string;
}

export interface CharacterVoiceConfig {
  manifest: string;
}

export interface CharacterProfile {
  schemaVersion: 1;
  id: string;
  name: string;
  reading: string;
  description: string;
  systemPrompt: string;
  greeting: string;
  /** 开场白的中文次级字幕，可选。 */
  greetingTranslation?: string;
  preferredLanguage: CharacterLanguage;
  moodLine: string;
  avatar?: string;
  live2d?: CharacterLive2DConfig;
  voice?: CharacterVoiceConfig;
}

export const DEFAULT_CHARACTER: CharacterProfile = {
  schemaVersion: 1,
  id: "aika.default",
  name: "愛花",
  reading: "あいか",
  description: "温柔、自然的日语陪伴角色",
  systemPrompt: AIKA_PERSONA_PROMPT,
  greeting: "おかえり。今日はどんな一日だった？",
  greetingTranslation: "你回来了。今天过得怎么样？",
  preferredLanguage: "ja-JP",
  moodLine: "今、ちょうど君のことを考えてた。",
};

function isSafeRelativePath(path: string) {
  const normalized = path.replace(/\\/g, "/");
  return Boolean(normalized) && !normalized.startsWith("/") && !normalized.includes("../") && !/^[a-zA-Z]:/.test(normalized);
}

export function validateCharacterProfile(value: unknown): string[] {
  if (!value || typeof value !== "object") return ["角色清单必须是一个 JSON 对象"];
  const profile = value as Partial<CharacterProfile>;
  const errors: string[] = [];
  if (profile.schemaVersion !== 1) errors.push("不支持的角色包版本");
  if (!profile.id?.trim()) errors.push("缺少角色 ID");
  if (!profile.name?.trim()) errors.push("缺少角色名称");
  if (!profile.systemPrompt?.trim()) errors.push("缺少角色人设提示词");
  if (!profile.greeting?.trim()) errors.push("缺少角色开场白");
  if (profile.avatar && !isSafeRelativePath(profile.avatar)) errors.push("头像路径必须位于角色包内");
  if (profile.live2d?.model && !isSafeRelativePath(profile.live2d.model)) errors.push("Live2D 路径必须位于角色包内");
  if (profile.voice?.manifest && !isSafeRelativePath(profile.voice.manifest)) errors.push("语音清单路径必须位于角色包内");
  return errors;
}
