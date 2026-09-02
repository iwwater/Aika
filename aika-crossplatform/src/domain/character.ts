import { AIKA_SYSTEM_PROMPT, WELCOME_TEXT } from "./persona";

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
  description: "温暖、自然的日语聊天伙伴",
  systemPrompt: AIKA_SYSTEM_PROMPT,
  greeting: WELCOME_TEXT,
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
