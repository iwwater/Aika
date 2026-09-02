import type { ChatMessage } from "../../domain/conversation";
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

export const appStorage = {
  loadProvider(fallback: ProviderConfig): ProviderConfig {
    const saved = readJson<ProviderConfig>(PROVIDER_KEY);
    return saved ? normalizeStoredProvider(saved) : fallback;
  },

  saveProvider(provider: ProviderConfig) {
    writeJson(PROVIDER_KEY, provider);
  },

  loadMessages(): ChatMessage[] | null {
    return readJson<ChatMessage[]>(MESSAGE_KEY);
  },

  saveMessages(messages: ChatMessage[]) {
    writeJson(MESSAGE_KEY, messages.filter((message) => !message.pending));
  },
};
