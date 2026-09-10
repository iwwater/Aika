import type { AikaStorage } from "./contracts";

/**
 * 设置读写。
 *
 * 把原本散在 useCompanionSession 启动流程里的 `JSON.parse` 与各式回退收进一处。
 *
 * 一条硬规则：**读到坏值一律回落默认值，且绝不把坏值写回存储。** 之前的写法
 * 在 try/catch 里各自决定回退，同一种坏数据在不同键上表现不一致；更要命的是
 * 一旦有人「顺手修一下再存回去」，坏数据就被固化成了正常数据。
 */
export interface SettingsStore {
  getRaw(key: string): Promise<string | null>;
  setRaw(key: string, value: string): Promise<void>;
  /**
   * 读 JSON。解析失败或 normalize 抛错都回落 fallback。
   * normalize 用来做字段级校验，不给它就只做 JSON.parse。
   */
  getJson<T>(key: string, fallback: T, normalize?: (value: unknown) => T): Promise<T>;
  setJson(key: string, value: unknown): Promise<void>;
  getBoolean(key: string, fallback: boolean): Promise<boolean>;
  setBoolean(key: string, value: boolean): Promise<void>;
  getString(key: string, fallback: string): Promise<string>;
}

export interface SettingsStoreOptions {
  /** 回落发生时记一笔，供诊断；不影响返回值。 */
  onFallback?: (key: string, reason: string) => void;
}

export function createSettingsStore(
  storage: Pick<AikaStorage, "getSetting" | "setSetting">,
  options: SettingsStoreOptions = {},
): SettingsStore {
  const fallback = (key: string, reason: string) => options.onFallback?.(key, reason);

  return {
    getRaw: (key) => storage.getSetting(key),
    setRaw: (key, value) => storage.setSetting(key, value),

    async getJson(key, fallbackValue, normalize) {
      const raw = await storage.getSetting(key);
      if (!raw) return fallbackValue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        fallback(key, "invalid json");
        return fallbackValue;
      }
      if (!normalize) return parsed as typeof fallbackValue;
      try {
        return normalize(parsed);
      } catch {
        // 结构对不上也是坏值，同样回落，同样不写回。
        fallback(key, "failed normalize");
        return fallbackValue;
      }
    },

    setJson: (key, value) => storage.setSetting(key, JSON.stringify(value)),

    async getBoolean(key, fallbackValue) {
      const raw = await storage.getSetting(key);
      if (raw === "true") return true;
      if (raw === "false") return false;
      if (raw) fallback(key, "not a boolean");
      return fallbackValue;
    },

    setBoolean: (key, value) => storage.setSetting(key, String(value)),

    async getString(key, fallbackValue) {
      const raw = await storage.getSetting(key);
      return raw || fallbackValue;
    },
  };
}
