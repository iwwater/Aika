/**
 * localStorage 版记忆存储（浏览器降级）。
 *
 * 没有事务可用，所以退而求其次：整份快照一次 setItem。
 * 写失败时抛错，旧快照原封不动——宁可这次没记住，也不能记住一半。
 */

import {
  MEMORY_SCHEMA_VERSION, emptySnapshot,
  type MemorySnapshot, type MemoryV2Store,
} from "./memoryStore";

export const MEMORY_V2_KEY = "aika.memories.v2";

export interface KeyValueBackend {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export function parseSnapshot(raw: string | null): MemorySnapshot {
  if (!raw) return emptySnapshot();
  try {
    const parsed = JSON.parse(raw) as Partial<MemorySnapshot>;
    if (!parsed || parsed.schemaVersion !== MEMORY_SCHEMA_VERSION) return emptySnapshot();
    return {
      schemaVersion: MEMORY_SCHEMA_VERSION,
      records: Array.isArray(parsed.records) ? parsed.records : [],
      suppressions: Array.isArray(parsed.suppressions) ? parsed.suppressions : [],
      migrationVersion: Number(parsed.migrationVersion ?? 0),
    };
  } catch {
    return emptySnapshot();
  }
}

export function createLocalMemoryStore(backend: KeyValueBackend): MemoryV2Store {
  return {
    async load(): Promise<MemorySnapshot> {
      return parseSnapshot(backend.get(MEMORY_V2_KEY));
    },
    async save(snapshot: MemorySnapshot): Promise<void> {
      // throwOnError：配额或安全错误必须冒出去，否则 UI 会以为记住了。
      backend.set(MEMORY_V2_KEY, JSON.stringify(snapshot));
    },
  };
}

/** 浏览器环境下的默认后端。 */
export function browserBackend(): KeyValueBackend {
  return {
    get: (key) => {
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    set: (key, value) => {
      localStorage.setItem(key, value);
    },
  };
}
