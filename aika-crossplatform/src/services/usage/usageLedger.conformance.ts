import { expect, it } from "vitest";
import {
  DEFAULT_USAGE_RETENTION_DAYS, USAGE_LEGACY_SCOPE,
  type UsageRecordV1,
} from "../../domain/usageLedger";
import type { UsageLedgerStore } from "./contracts";

/**
 * UsageLedgerStore 的端口一致性用例包（LLM-12-C/D）。
 *
 * 每个实现都跑这一份，只断言**契约层面可观测的行为**：按 id 幂等 upsert、
 * 固定顺序、scope 隔离与 legacy 分组、过滤、cursor 翻页不丢不重、保留期截断。
 * 实现细节（SQL、Map 结构）不进用例包；持久性差异由各自实现如实声明——
 * 内存实现不承诺跨实例存活，SQLite 通过 reopen 用例验证重启恢复。
 */

/**
 * 用例包里所有时间戳的基准。不能用小数字：保留期清理拿真实纪元一比，
 * 「1970 年的记录」第一次写入就会把自己扫掉。
 */
export const USAGE_BASE_AT = 1_700_000_000_000;

export interface UsageLedgerHarness {
  name: string;
  create(): Promise<{
    subject: UsageLedgerStore;
    dispose(): Promise<void>;
    /** 同一底层存储重开一个实例；不支持（内存实现）就不提供。 */
    reopen?(): Promise<UsageLedgerStore>;
  }>;
}

let recordCounter = 0;

export function usageRecord(overrides: Partial<UsageRecordV1> = {}): UsageRecordV1 {
  recordCounter += 1;
  const index = recordCounter;
  return {
    schemaVersion: 1,
    id: `attempt-${index}`,
    logicalRequestId: `req-${Math.ceil(index / 4)}`,
    purpose: "foreground",
    providerId: "prov-a",
    protocol: "openai-compatible",
    model: "model-a",
    startedAt: USAGE_BASE_AT,
    status: "completed",
    promptTokens: 100,
    completionTokens: 50,
    totalTokens: 150,
    coverage: "reported",
    ...overrides,
  };
}

export function runUsageLedgerConformance(harness: UsageLedgerHarness): void {
  it("按 id 幂等 upsert：终态覆盖开始登记，不产生第二条", async () => {
    const { subject, dispose } = await harness.create();
    try {
      const id = "attempt-idem";
      await subject.upsert(usageRecord({
        id, logicalRequestId: "req-idem", status: "unfinished", endedAt: undefined,
        promptTokens: null, completionTokens: null, totalTokens: null, coverage: "unknown",
      }));
      await subject.upsert(usageRecord({
        id, logicalRequestId: "req-idem", status: "completed", endedAt: USAGE_BASE_AT + 500,
        promptTokens: 10, completionTokens: 20, totalTokens: 30, coverage: "reported",
      }));

      const page = await subject.query({ limit: 100 });
      const mine = page.records.filter((record) => record.id === id);
      expect(mine).toHaveLength(1);
      expect(mine[0].status).toBe("completed");
      expect(mine[0].totalTokens).toBe(30);
      expect(mine[0].coverage).toBe("reported");
    } finally {
      await dispose();
    }
  });

  it("固定顺序返回（新→旧，同刻按 id 破平）", async () => {
    const { subject, dispose } = await harness.create();
    try {
      await subject.upsert(usageRecord({ id: "b", startedAt: USAGE_BASE_AT }));
      await subject.upsert(usageRecord({ id: "a", startedAt: USAGE_BASE_AT }));
      await subject.upsert(usageRecord({ id: "c", startedAt: USAGE_BASE_AT - 1 }));

      const page = await subject.query({ limit: 100 });
      expect(page.records.map((record) => record.id)).toEqual(["b", "a", "c"]);
    } finally {
      await dispose();
    }
  });

  it("scope 隔离：无 scope 的归 legacy 分组，不混进任何主体", async () => {
    const { subject, dispose } = await harness.create();
    try {
      await subject.upsert(usageRecord({ id: "old-1", logicalRequestId: "r1" }));
      await subject.upsert(usageRecord({ id: "old-2", logicalRequestId: "r1" }));
      await subject.upsert(usageRecord({ id: "c1-1", logicalRequestId: "r2", scope: "char-1" }));
      await subject.upsert(usageRecord({ id: "c2-1", logicalRequestId: "r3", scope: "char-2" }));

      const legacy = await subject.query({ scope: USAGE_LEGACY_SCOPE, limit: 100 });
      expect(legacy.records.map((record) => record.id).sort()).toEqual(["old-1", "old-2"]);

      const c1 = await subject.query({ scope: "char-1", limit: 100 });
      expect(c1.records.map((record) => record.id)).toEqual(["c1-1"]);

      const c2 = await subject.query({ scope: "char-2", limit: 100 });
      expect(c2.records.map((record) => record.id)).toEqual(["c2-1"]);

      // 不带 scope 过滤 = 全量。
      const all = await subject.query({ limit: 100 });
      expect(all.records).toHaveLength(4);
    } finally {
      await dispose();
    }
  });

  it("purpose/providerId/时间范围过滤各自生效", async () => {
    const { subject, dispose } = await harness.create();
    try {
      await subject.upsert(usageRecord({ id: "fg", purpose: "foreground", providerId: "prov-a" }));
      await subject.upsert(usageRecord({ id: "mt", purpose: "maintenance", providerId: "prov-b" }));
      await subject.upsert(usageRecord({ id: "sm", purpose: "summary", startedAt: USAGE_BASE_AT - 1000 }));

      expect((await subject.query({ purpose: "maintenance", limit: 100 })).records.map((r) => r.id)).toEqual(["mt"]);
      expect((await subject.query({ providerId: "prov-b", limit: 100 })).records.map((r) => r.id)).toEqual(["mt"]);
      expect((await subject.query({ since: USAGE_BASE_AT - 500, limit: 100 })).records.map((r) => r.id).sort())
        .toEqual(["fg", "mt"]);
      expect((await subject.query({ until: USAGE_BASE_AT - 500, limit: 100 })).records.map((r) => r.id)).toEqual(["sm"]);
    } finally {
      await dispose();
    }
  });

  it("cursor 翻页不丢不重，尽头 nextCursor 为 null 且 truncated 如实", async () => {
    const { subject, dispose } = await harness.create();
    try {
      for (let index = 0; index < 25; index += 1) {
        await subject.upsert(usageRecord({
          id: `p-${String(index).padStart(2, "0")}`,
          logicalRequestId: `req-p`,
          startedAt: USAGE_BASE_AT + index,
        }));
      }

      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      for (;;) {
        const page = await subject.query({ limit: 10, ...(cursor ? { cursor } : {}) });
        seen.push(...page.records.map((record) => record.id));
        pages += 1;
        if (!page.nextCursor) {
          expect(page.truncated).toBe(false);
          break;
        }
        expect(page.truncated).toBe(true);
        cursor = page.nextCursor;
        expect(pages).toBeLessThan(10);
      }
      expect(pages).toBe(3);
      expect(seen).toHaveLength(25);
      expect(new Set(seen).size).toBe(25);
      // 顺序：从新到旧。
      expect(seen[0]).toBe("p-24");
      expect(seen[24]).toBe("p-00");
    } finally {
      await dispose();
    }
  });

  it("保留期之外的记录被截断清理，保留天数用默认常量", async () => {
    const { subject, dispose } = await harness.create();
    try {
      const stale = USAGE_BASE_AT - DEFAULT_USAGE_RETENTION_DAYS * 86_400_000 - 1;
      await subject.upsert(usageRecord({ id: "stale", startedAt: stale }));
      await subject.upsert(usageRecord({ id: "fresh", startedAt: USAGE_BASE_AT }));

      const page = await subject.query({ limit: 100 });
      expect(page.records.map((record) => record.id)).toEqual(["fresh"]);
    } finally {
      await dispose();
    }
  });

  it("重启恢复：同一底层存储重开后记录还在（仅承诺持久性的实现）", async () => {
    const { subject, dispose, reopen } = await harness.create();
    try {
      if (!reopen) return;
      await subject.upsert(usageRecord({ id: "survive", logicalRequestId: "req-s" }));
      const revived = await reopen();
      const page = await revived.query({ limit: 100 });
      expect(page.records.map((record) => record.id)).toEqual(["survive"]);
    } finally {
      await dispose();
    }
  });
}
