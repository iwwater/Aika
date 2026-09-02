import { invoke } from "@tauri-apps/api/core";

/**
 * API Key 保险库。
 *
 * 桌面版走 Rust 侧的 Windows DPAPI（见 src-tauri/src/secret_store.rs），
 * 密文绑定当前 Windows 账户，和聊天记录、记忆分开存放。
 *
 * 浏览器里跑 `npm run dev` 时没有 DPAPI，退回明文 localStorage，
 * 并把 `secure` 置为 false——设置页据此显示明确警告，不假装安全。
 */
const INSECURE_KEY = "aika.insecure.secrets.v1";

function inTauri(): boolean {
  return "__TAURI_INTERNALS__" in globalThis;
}

function readInsecure(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(INSECURE_KEY) ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
}

function writeInsecure(entries: Record<string, string>) {
  localStorage.setItem(INSECURE_KEY, JSON.stringify(entries));
}

export interface SecretStore {
  /** true 表示落在加密保险库里；false 表示当前是开发期明文回退。 */
  secure(): Promise<boolean>;
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  remove(name: string): Promise<void>;
}

export const secretStore: SecretStore = {
  async secure() {
    if (!inTauri()) return false;
    try {
      return await invoke<boolean>("secret_available");
    } catch {
      return false;
    }
  },

  async get(name) {
    if (!inTauri()) return readInsecure()[name] ?? null;
    return (await invoke<string | null>("secret_get", { name })) ?? null;
  },

  async set(name, value) {
    if (!inTauri()) {
      const entries = readInsecure();
      if (value) entries[name] = value;
      else delete entries[name];
      writeInsecure(entries);
      return;
    }
    await invoke("secret_set", { name, value });
  },

  async remove(name) {
    if (!inTauri()) {
      const entries = readInsecure();
      delete entries[name];
      writeInsecure(entries);
      return;
    }
    await invoke("secret_delete", { name });
  },
};

/** 每个供应商一把 Key，切换平台不会互相覆盖。对齐 Android 的 SecretStore.providerKeyName。 */
export function providerKeyName(providerId: string): string {
  return `provider.${providerId}.apiKey`;
}
