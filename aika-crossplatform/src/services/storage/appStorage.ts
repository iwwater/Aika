import type { ChatMessage } from "../../domain/conversation";
import { formatClockTime } from "../../domain/conversation";
import type { ProviderConfig } from "../../domain/providers";
import { normalizeStoredProvider } from "../../domain/providers";

const PROVIDER_KEY = "aika.provider.v1";
const MESSAGE_KEY = "aika.messages.v1";

function readJson<T>(key: string): T | null {
  try {
    const saved = localStorage.getItem(key);
    return saved ? JSON.parse(saved) as T : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown) {
  localStorage.setItem(key, JSON.stringify(value));
}

/**
 * 兼容 createdAt 之前的记录。
 * 旧记录只存了 HH:mm，日期无法还原，统一按“同一天、导入时刻”处理；
 * 关系状态因此不会凭空虚高，只是把这段历史压成一天。
 */
function normalizeStoredMessages(messages: ChatMessage[], now: number): ChatMessage[] {
  return messages.map((message, index) => {
    if (typeof message.createdAt === "number") return message;
    const createdAt = now - (messages.length - index) * 1000;
    return { ...message, createdAt, time: message.time ?? formatClockTime(createdAt) };
  });
}

export const appStorage = {
  loadProvider(fallback: ProviderConfig): ProviderConfig {
    const saved = readJson<ProviderConfig>(PROVIDER_KEY);
    return saved ? normalizeStoredProvider(saved) : fallback;
  },

  saveProvider(provider: ProviderConfig) {
    writeJson(PROVIDER_KEY, provider);
  },

  loadMessages(now: number = Date.now()): ChatMessage[] | null {
    const saved = readJson<ChatMessage[]>(MESSAGE_KEY);
    return saved ? normalizeStoredMessages(saved, now) : null;
  },

  saveMessages(messages: ChatMessage[]) {
    writeJson(MESSAGE_KEY, messages.filter((message) => !message.pending));
  },
};
