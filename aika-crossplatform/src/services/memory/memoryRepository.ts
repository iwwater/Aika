/**
 * MemoryRepository。
 *
 * 所有写操作都是「读快照 → 在内存里算好新快照 → 一次性替换」，
 * 所以 supersede、forget 与抑制标记要么一起生效，要么一起不发生。
 *
 * 两条不能破的规矩：
 * 1. 删掉的记忆不能靠旧来源复活——抑制标记比对的是内容指纹 + 来源消息，
 *    正文一个字都不留；但用户亲手写的（userEdit）永远可以重新记住。
 * 2. 访问不等于确认。检索只更新 lastAccessedAt，不去动 status 或 lastConfirmedAt。
 */

import {
  isDuplicateMemoryV2, memoryContentHash, migrateMemoryRecord,
  type MemoryRecord, type MemoryRecordV2,
} from "../../domain/memory";
import {
  RETRIEVAL_ALGORITHM_VERSION, rankMemories,
  type MemoryHit, type MemoryQuery,
} from "../../domain/memoryRetrieval";
import type { MemorySnapshot, MemorySuppression, MemoryV2Store } from "./memoryStore";

/** 迁移版本号。改迁移动作时递增，存储侧据此判断是否需要重跑。 */
export const MEMORY_MIGRATION_VERSION = 1;

/** mutate 返回它表示「这次没有任何改动」，跳过写盘。 */
const SKIP_SAVE = Symbol("memory.skipSave");

export interface MemoryInvalidation {
  recordId: string;
  sourceMessageIds: string[];
  contentHash: string;
}

export interface MemoryRepositoryOptions {
  store: MemoryV2Store;
  clock?: () => number;
  /**
   * 删除之后的联动：失效相关摘要与画像。
   * 旧摘要无法溯源到具体消息，因此调用方应当保守地整段失效。
   */
  onInvalidate?: (event: MemoryInvalidation) => Promise<void> | void;
}

export interface MemoryRepository {
  readonly algorithmVersion: string;
  retrieve(query: MemoryQuery): Promise<MemoryHit[]>;
  upsert(records: readonly MemoryRecordV2[]): Promise<void>;
  supersede(oldId: string, next: MemoryRecordV2): Promise<void>;
  forget(id: string): Promise<boolean>;
  /** 把 V1 记忆并入 V2。幂等：重复运行不产生重复记录。 */
  migrateLegacy(records: readonly MemoryRecord[]): Promise<number>;
  list(): Promise<readonly MemoryRecordV2[]>;
}

function mergeSources(base: MemoryRecordV2, incoming: MemoryRecordV2): string[] {
  return [...new Set([...base.sourceMessageIds, ...incoming.sourceMessageIds])];
}

export function createMemoryRepository(options: MemoryRepositoryOptions): MemoryRepository {
  const clock = options.clock ?? (() => Date.now());
  const { store } = options;

  async function withSnapshot<T>(
    mutate: (snapshot: MemorySnapshot) => T | typeof SKIP_SAVE | Promise<T | typeof SKIP_SAVE>,
  ): Promise<T | null> {
    const snapshot = await store.load();
    const result = await mutate(snapshot);
    // 什么都没改就不要写：删一条不存在的记忆不该产生任何持久化副作用。
    if (result === SKIP_SAVE) return null;
    await store.save(snapshot);
    return result;
  }

  return {
    algorithmVersion: RETRIEVAL_ALGORITHM_VERSION,

    async list(): Promise<readonly MemoryRecordV2[]> {
      return (await store.load()).records;
    },

    async retrieve(query: MemoryQuery): Promise<MemoryHit[]> {
      const snapshot = await store.load();

      // 有索引时先用它缩小候选；候选为空（例如 2 字中文词，trigram 召回不到）
      // 或候选内没有命中，就回退全量——索引只做加速，不能决定孰对孰错。
      const candidateIds = store.searchIds ? await store.searchIds(query.text) : null;
      let hits = candidateIds?.length
        ? rankMemories(snapshot.records.filter((record) => candidateIds.includes(record.id)), query)
        : [];
      if (!hits.length) hits = rankMemories(snapshot.records, query);
      if (!hits.length) return hits;

      // 只记「被读到」，不改状态也不改确认时间：读得多不代表这条事实更新或更真。
      const now = query.now ?? clock();
      const accessed = new Set(hits.map((hit) => hit.record.id));
      let touched = false;
      for (const record of snapshot.records) {
        if (accessed.has(record.id) && record.lastAccessedAt !== now) {
          record.lastAccessedAt = now;
          touched = true;
        }
      }
      if (touched) {
        try {
          await store.save(snapshot);
        } catch {
          // 访问时间写不进去不影响这一轮检索结果，不该让对话失败。
        }
      }
      return hits;
    },

    async upsert(records: readonly MemoryRecordV2[]): Promise<void> {
      if (!records.length) return;
      await withSnapshot((snapshot) => {
        const now = clock();
        for (const incoming of records) {
          if (!incoming || !incoming.content.trim()) continue;

          // 抑制标记：内容指纹相同、来源消息有交集，且不是用户亲手写的 → 不复活。
          const hash = memoryContentHash(incoming.content);
          const suppressed = snapshot.suppressions.some((item) => (
            item.contentHash === hash
            && incoming.sourceKind !== "userEdit"
            && incoming.sourceMessageIds.some((id) => item.sourceMessageIds.includes(id))
          ));
          if (suppressed) continue;

          const byId = snapshot.records.findIndex((record) => record.id === incoming.id);
          if (byId >= 0) {
            const base = snapshot.records[byId];
            snapshot.records[byId] = {
              ...base,
              ...incoming,
              sourceMessageIds: mergeSources(base, incoming),
              createdAt: base.createdAt,
              updatedAt: now,
            };
            continue;
          }

          const duplicateIndex = snapshot.records.findIndex((record) => (
            record.status !== "superseded"
            && isDuplicateMemoryV2(incoming.content, [record])
          ));
          if (duplicateIndex >= 0) {
            const base = snapshot.records[duplicateIndex];
            const sources = mergeSources(base, incoming);
            snapshot.records[duplicateIndex] = {
              ...base,
              sourceMessageIds: sources,
              updatedAt: now,
              // 两份独立证据不等于用户确认，只把置信度交给调用方判断。
              confidence: incoming.confidence ?? base.confidence,
              lastConfirmedAt: incoming.status === "confirmed" ? now : base.lastConfirmedAt,
            };
            continue;
          }

          snapshot.records.push({ ...incoming, createdAt: incoming.createdAt ?? now, updatedAt: now });
        }
      });
    },

    async supersede(oldId: string, next: MemoryRecordV2): Promise<void> {
      await withSnapshot((snapshot) => {
        const now = clock();
        const index = snapshot.records.findIndex((record) => record.id === oldId);
        if (index >= 0) {
          snapshot.records[index] = {
            ...snapshot.records[index],
            status: "superseded",
            updatedAt: now,
            validUntil: snapshot.records[index].validUntil ?? now,
          };
        }
        const existing = snapshot.records.findIndex((record) => record.id === next.id);
        const record: MemoryRecordV2 = {
          ...next,
          supersedesId: oldId,
          createdAt: next.createdAt ?? now,
          updatedAt: now,
        };
        if (existing >= 0) {
          snapshot.records[existing] = {
            ...snapshot.records[existing],
            ...record,
            sourceMessageIds: mergeSources(snapshot.records[existing], next),
          };
        } else {
          snapshot.records.push(record);
        }
      });
    },

    async forget(id: string): Promise<boolean> {
      const result = await withSnapshot((snapshot) => {
        const index = snapshot.records.findIndex((record) => record.id === id);
        if (index < 0) return SKIP_SAVE;
        const [removed] = snapshot.records.splice(index, 1);
        const suppression: MemorySuppression = {
          id: removed.id,
          contentHash: memoryContentHash(removed.content),
          sourceMessageIds: [...removed.sourceMessageIds],
          createdAt: clock(),
        };
        if (!snapshot.suppressions.some((item) => item.id === suppression.id)) {
          snapshot.suppressions.push(suppression);
        }
        // 被它取代过的记录一起清掉，否则旧版本会留在库里继续被检索到。
        snapshot.records = snapshot.records.map((record) => (
          record.supersedesId === id
            ? { ...record, status: "superseded" as const, updatedAt: clock() }
            : record
        ));
        return { removed, suppression };
      });

      if (!result) return false;
      await options.onInvalidate?.({
        recordId: result.removed.id,
        sourceMessageIds: result.suppression.sourceMessageIds,
        contentHash: result.suppression.contentHash,
      });
      return true;
    },

    async migrateLegacy(records: readonly MemoryRecord[]): Promise<number> {
      return (await withSnapshot((snapshot) => {
        let added = 0;
        for (const legacy of records) {
          if (!legacy?.id || !legacy.content?.trim()) continue;
          if (snapshot.records.some((record) => record.id === legacy.id)) continue;
          const migrated = migrateMemoryRecord(legacy);
          if (isDuplicateMemoryV2(migrated.content, snapshot.records)) continue;
          snapshot.records.push(migrated);
          added += 1;
        }
        // 版本最后更新：只有整批都写进去了才算迁移完成，重跑不会留下半截数据。
        snapshot.migrationVersion = Math.max(snapshot.migrationVersion, MEMORY_MIGRATION_VERSION);
        return added;
      })) ?? 0;
    },
  };
}
