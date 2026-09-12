/**
 * 维护批次日志的存储适配（LLM-04）。
 *
 * 批次快照整体存进一条 KV 记录：localStorage 没有多键事务，单记录原子替换
 * 就是它能给到的最强提交边界；SQLite 侧同样先以这条路径落地，真实事务
 * 语义归存储层（INT-01 验证）。坏记录按"没有日志"处理，从零开始不抛错。
 */

import type { MaintenanceJournal, MaintenanceJournalState } from "./writeback";

export const MAINTENANCE_JOURNAL_KEY = "memory.maintenance.journal.v1";

export interface MaintenanceJournalStorage {
  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string): Promise<void>;
}

export function createStorageMaintenanceJournal(storage: MaintenanceJournalStorage): MaintenanceJournal {
  return {
    async load(): Promise<MaintenanceJournalState | null> {
      const raw = await storage.getSetting(MAINTENANCE_JOURNAL_KEY);
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw) as MaintenanceJournalState;
        if (!parsed || typeof parsed.epoch !== "number" || !Array.isArray(parsed.batches)) return null;
        return parsed;
      } catch {
        return null;
      }
    },

    async save(state: MaintenanceJournalState): Promise<void> {
      await storage.setSetting(MAINTENANCE_JOURNAL_KEY, JSON.stringify(state));
    },
  };
}
