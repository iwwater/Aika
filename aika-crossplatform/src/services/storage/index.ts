import { formatClockTime, type ChatMessage } from "../../domain/conversation";
import type { ProviderConfig } from "../../domain/providers";
import { normalizeStoredProvider } from "../../domain/providers";
import { SETTING_KEYS, type AikaStorage } from "./contracts";
import { createLocalStorage } from "./localStorageStorage";
import { providerKeyName, secretStore } from "./secretStore";
import { createSqliteStorage } from "./sqliteStorage";

export { SETTING_KEYS, type AikaStorage } from "./contracts";
export { providerKeyName, secretStore } from "./secretStore";

const LEGACY_MESSAGES_KEY = "aika.messages.v1";
const LEGACY_PROVIDER_KEY = "aika.provider.v1";
const MIGRATION_FLAG = "migrated.localStorage.v1";

function inTauri(): boolean {
  return "__TAURI_INTERNALS__" in globalThis;
}

function readLegacy<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

/**
 * 把 0.3 版留在 localStorage 里的数据搬进 SQLite，只跑一次。
 *
 * 旧记录只存了 HH:mm，日期无法还原，统一按「同一天、导入时刻」处理——
 * 关系状态因此不会凭空虚高，只是把那段历史压成一天。
 *
 * API Key 是唯一会被删除的东西：把它留在 localStorage 就等于这次迁移白做。
 */
async function migrateLegacy(storage: AikaStorage): Promise<void> {
  if (await storage.getSetting(MIGRATION_FLAG)) return;

  const legacyMessages = readLegacy<ChatMessage[]>(LEGACY_MESSAGES_KEY);
  if (legacyMessages?.length) {
    const now = Date.now();
    for (const [index, message] of legacyMessages.entries()) {
      const createdAt = typeof message.createdAt === "number"
        ? message.createdAt
        : now - (legacyMessages.length - index) * 1000;
      await storage.appendMessage({
        ...message,
        id: message.id || crypto.randomUUID(),
        createdAt,
        time: message.time ?? formatClockTime(createdAt),
      });
    }
  }

  const legacyProvider = readLegacy<ProviderConfig>(LEGACY_PROVIDER_KEY);
  if (legacyProvider) {
    const { apiKey, ...rest } = legacyProvider;
    await storage.setSetting(SETTING_KEYS.provider, JSON.stringify(rest));
    if (apiKey) {
      await secretStore.set(providerKeyName(legacyProvider.id), apiKey);
      // 只有确认写进保险库之后才清掉明文。
      localStorage.removeItem(LEGACY_PROVIDER_KEY);
    }
  }

  await storage.setSetting(MIGRATION_FLAG, String(Date.now()));
}

export async function openStorage(): Promise<AikaStorage> {
  if (!inTauri()) return createLocalStorage();
  const storage = await createSqliteStorage();
  await migrateLegacy(storage);
  return storage;
}

/** 供应商配置存 settings 表（不含 Key），Key 单独走保险库。 */
export async function loadProvider(
  storage: AikaStorage,
  fallback: ProviderConfig,
): Promise<ProviderConfig> {
  const raw = await storage.getSetting(SETTING_KEYS.provider);
  const saved = raw ? (JSON.parse(raw) as Omit<ProviderConfig, "apiKey">) : null;
  const base = saved ? normalizeStoredProvider({ ...saved, apiKey: "" }) : fallback;
  const apiKey = (await secretStore.get(providerKeyName(base.id))) ?? "";
  return { ...base, apiKey };
}

export async function saveProvider(storage: AikaStorage, provider: ProviderConfig): Promise<void> {
  const { apiKey, ...rest } = provider;
  await storage.setSetting(SETTING_KEYS.provider, JSON.stringify(rest));
  await secretStore.set(providerKeyName(provider.id), apiKey);
}
