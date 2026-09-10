/**
 * 记忆的持久化端口。
 *
 * 整个快照一次性替换，而不是逐条增删改：记忆之间有 supersede 关系、
 * 删除还要落下抑制标记，逐条写会让「旧记录删了但抑制标记没写」这种半截状态
 * 真实存在。SQLite 侧用事务，localStorage 侧用一次 setItem，
 * 两边都保证：**失败就抛错，已持久化的数据一个字节都不动。**
 */

import type { MemoryRecordV2 } from "../../domain/memory";

export const MEMORY_SCHEMA_VERSION = 2;

/** 删除后留下的最小痕迹：只有指纹与来源，没有正文。 */
export interface MemorySuppression {
  id: string;
  contentHash: string;
  sourceMessageIds: string[];
  createdAt: number;
}

export interface MemorySnapshot {
  schemaVersion: 2;
  records: MemoryRecordV2[];
  suppressions: MemorySuppression[];
  /** 迁移版本在事务最后更新，重复运行因此是幂等的。 */
  migrationVersion: number;
}

export interface MemoryV2Store {
  load(): Promise<MemorySnapshot>;
  save(snapshot: MemorySnapshot): Promise<void>;
  /**
   * 可选：用索引召回候选 id。
   *
   * 有索引的存储（SQLite FTS5）实现它来缩小候选集；返回空数组表示
   * 「索引没召回任何东西」，调用方必须回退全量扫描——分词器对 2 字中文词
   * 无能为力，不能因此漏掉记忆。没实现表示该存储只能全量扫描。
   */
  searchIds?(text: string): Promise<string[]>;
}

export function emptySnapshot(): MemorySnapshot {
  return { schemaVersion: MEMORY_SCHEMA_VERSION, records: [], suppressions: [], migrationVersion: 0 };
}

export interface InMemoryStoreOptions {
  initial?: Partial<MemorySnapshot>;
}

/**
 * 内存实现。
 *
 * 它是给测试和没有 SQLite 的环境用的；生产桌面端走 sqliteMemoryStore。
 * `failNextSave` 用来测「事务失败后快照保持不变」。
 */
export function createInMemoryMemoryStore(options: InMemoryStoreOptions = {}): MemoryV2Store & {
  failNextSave: boolean;
  saveCount: number;
  current(): MemorySnapshot;
} {
  let snapshot: MemorySnapshot = {
    ...emptySnapshot(),
    ...options.initial,
    records: [...(options.initial?.records ?? [])],
    suppressions: [...(options.initial?.suppressions ?? [])],
  };
  const store = {
    failNextSave: false,
    saveCount: 0,
    async load(): Promise<MemorySnapshot> {
      return {
        ...snapshot,
        records: snapshot.records.map((record) => ({ ...record })),
        suppressions: snapshot.suppressions.map((item) => ({ ...item })),
      };
    },
    async save(next: MemorySnapshot): Promise<void> {
      if (store.failNextSave) {
        store.failNextSave = false;
        throw new Error("存储写入失败（注入）");
      }
      store.saveCount += 1;
      snapshot = {
        ...next,
        records: next.records.map((record) => ({ ...record })),
        suppressions: next.suppressions.map((item) => ({ ...item })),
      };
    },
    current(): MemorySnapshot {
      return snapshot;
    },
  };
  return store;
}
