/**
 * Permission 请求的持久存储（RT-03）。
 *
 * 单进程内的原子性由「同步改内存 Map、再异步持久化」保证：JS 在同一个任务里
 * 的 check-and-set 之间不会插入其它任务，审批/撤销/认领的竞争天然串行。
 * 持久化用存储 KV 的整份 JSON 原子替换；重启后 pending 保持 pending——
 * **绝不自动批准**。
 */

import type { PermissionRecordV1 } from "../../domain/permission";
import type { AikaStorage } from "../storage/contracts";
import { SETTING_KEYS } from "../storage/contracts";

export const PERMISSION_STORE_KEY = "permission.requests.v1";
export const PERMISSION_STORE_SCHEMA_VERSION = 1;
/** 已终结记录的保留上限：防 KV 无界增长；最旧的先淘汰。 */
export const MAX_PERSISTED_RECORDS = 200;

export interface PermissionStore {
  create(record: PermissionRecordV1): Promise<void>;
  get(requestId: string): Promise<PermissionRecordV1 | null>;
  /** 同步读当前内存视图：决策/认领的原子判定走这里，不跨 await。 */
  current(requestId: string): PermissionRecordV1 | null;
  /** 原子替换整条记录（同任务内 check-and-set 之后调用）。 */
  replace(record: PermissionRecordV1): Promise<void>;
  listPending(): PermissionRecordV1[];
  /** 已终结且已认领的记录清理出界，防无界增长。 */
  pruneDecided(now: number, keepMs: number): void;
}

interface StoredDocument {
  schemaVersion: 1;
  records: PermissionRecordV1[];
}

export function createPermissionStore(loadStorage: () => Promise<AikaStorage>): PermissionStore {
  const records = new Map<string, PermissionRecordV1>();
  let loaded = false;

  async function persist(): Promise<void> {
    const storage = await loadStorage();
    const decided = [...records.values()].filter((record) => record.state !== "pending" && record.execution);
    const document: StoredDocument = {
      schemaVersion: PERMISSION_STORE_SCHEMA_VERSION,
      records: [...records.values()].slice(-MAX_PERSISTED_RECORDS + Math.min(decided.length, MAX_PERSISTED_RECORDS)),
    };
    await storage.setSetting(SETTING_KEYS.permissionRequests, JSON.stringify(document));
  }

  async function ensureLoaded(): Promise<void> {
    if (loaded) return;
    loaded = true;
    try {
      const storage = await loadStorage();
      const raw = await storage.getSetting(SETTING_KEYS.permissionRequests);
      if (!raw) return;
      const parsed = JSON.parse(raw) as StoredDocument;
      if (parsed && parsed.schemaVersion === PERMISSION_STORE_SCHEMA_VERSION && Array.isArray(parsed.records)) {
        for (const record of parsed.records) {
          if (record?.request?.requestId) records.set(record.request.requestId, record);
        }
      }
    } catch {
      // 损坏按空库处理：pending 丢了是「没批准过」，绝不是「批准过」。
      records.clear();
    }
  }

  return {
    async create(record) {
      await ensureLoaded();
      records.set(record.request.requestId, record);
      await persist();
    },

    async get(requestId) {
      await ensureLoaded();
      return records.get(requestId) ?? null;
    },

    current(requestId) {
      return records.get(requestId) ?? null;
    },

    async replace(record) {
      records.set(record.request.requestId, record);
      await persist();
    },

    listPending() {
      return [...records.values()].filter((record) => record.state === "pending");
    },

    pruneDecided(now, keepMs) {
      for (const [id, record] of records) {
        const isDone = record.state !== "pending" && (record.execution || record.state === "rejected" || record.state === "cancelled");
        if (isDone && record.decidedAt !== undefined && now - record.decidedAt > keepMs) {
          records.delete(id);
        }
      }
    },
  };
}
