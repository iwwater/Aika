import { describe, expect, it } from "vitest";
import type { UsageRecordV1 } from "./usageLedger";
import {
  localDayKey, priceForRecord, recordCost, summarizeUsage, validatePriceEntry,
  type PriceEntryV1,
} from "./usageStats";
import type { ProviderUsage } from "./providers";

const BASE = Date.UTC(2026, 0, 10, 12, 0); // 2026-01-10 12:00 UTC

function record(overrides: Partial<UsageRecordV1> = {}): UsageRecordV1 {
  return {
    schemaVersion: 1,
    id: "a1",
    logicalRequestId: "r1",
    purpose: "foreground",
    providerId: "prov-a",
    protocol: "openai-compatible",
    model: "model-a",
    startedAt: BASE,
    status: "completed",
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
    coverage: "unknown",
    ...overrides,
  };
}

function price(overrides: Partial<PriceEntryV1> = {}): PriceEntryV1 {
  return {
    id: "p1",
    model: "model-a",
    providerId: "prov-a",
    currency: "USD",
    effectiveFrom: "2026-01-01",
    inputPerMillion: 2,
    outputPerMillion: 8,
    ...overrides,
  };
}

function usage(promptTokens: number | null, completionTokens: number | null, totalTokens: number | null): ProviderUsage {
  return { promptTokens, completionTokens, totalTokens };
}

describe("recordCost 与 SPEC 算例（FE-26 全文审阅）", () => {
  it("input=1000/output=500、单价 2/8 → 0.006（同币种）", () => {
    const entry = price();
    const cost = recordCost(record({
      promptTokens: 1000, completionTokens: 500, totalTokens: 1500, coverage: "reported",
    }), entry);
    expect(cost).toBe(0.006);
  });

  it("只有 total 的记录不拆分、不计价", () => {
    const entry = price();
    const partial = record({
      promptTokens: null, completionTokens: null, totalTokens: 1500, coverage: "partial",
    });
    expect(recordCost(partial, entry)).toBeNull();
  });

  it("舍入到 6 位小数：0.1+0.2 类浮点误差不放大", () => {
    const entry = price({ inputPerMillion: 0.1, outputPerMillion: 0.2 });
    const cost = recordCost(record({ promptTokens: 1, completionTokens: 1, totalTokens: 2 }), entry);
    expect(cost).toBe(0.0000003);
  });
});

describe("priceForRecord 生效日选择", () => {
  it("多条价目取「不晚于记录当日」的最新一条；生效日含当天", () => {
    const prices = [
      price({ id: "old", effectiveFrom: "2026-01-01", inputPerMillion: 1 }),
      price({ id: "new", effectiveFrom: "2026-01-10", inputPerMillion: 3 }),
    ];
    const matched = priceForRecord(prices, record({ startedAt: BASE + 86_400_000 }));
    expect(matched?.id).toBe("new");

    // 2026-01-10 当天：new 生效（含当天）。
    expect(priceForRecord(prices, record())?.id).toBe("new");
    // 生效日之前用旧价；更早的记录用不到任何价。
    const midPeriod = priceForRecord(prices, record({ startedAt: Date.UTC(2026, 0, 5) }));
    expect(midPeriod?.id).toBe("old");
    const early = priceForRecord(prices, record({ startedAt: Date.UTC(2025, 11, 1) }));
    expect(early).toBeNull();
  });

  it("providerId 或 model 不匹配不套价", () => {
    const prices = [price()];
    expect(priceForRecord(prices, record({ providerId: "prov-b" }))).toBeNull();
    expect(priceForRecord(prices, record({ model: "model-b" }))).toBeNull();
  });
});

describe("validatePriceEntry 拒绝非法输入", () => {
  it("负单价、非数字、缺字段、坏日期都被拒绝", () => {
    expect(validatePriceEntry(price())).toBeNull();
    expect(validatePriceEntry(price({ inputPerMillion: -1 }))).toContain("不能为负");
    expect(validatePriceEntry(price({ outputPerMillion: Number.NaN }))).toContain("必须是数字");
    expect(validatePriceEntry(price({ model: " " }))).toContain("模型");
    expect(validatePriceEntry(price({ currency: "" }))).toContain("币种");
    expect(validatePriceEntry(price({ effectiveFrom: "2026/01/01" }))).toContain("YYYY-MM-DD");
  });
});

describe("summarizeUsage（FE-26-A/B/C/D）", () => {
  it("重复事件幂等：同 attemptId 只算一次", () => {
    const one = record({ promptTokens: 10, completionTokens: 10, totalTokens: 20, coverage: "reported" });
    const summary = summarizeUsage([one, { ...one }, { ...one }]);
    expect(summary.records).toBe(1);
    expect(summary.duplicatesAbsorbed).toBe(2);
    expect(summary.tokens.total).toBe(20);
  });

  it("错误率分母与取消定义：failed/(completed+failed)，取消与无终态另计", () => {
    const summary = summarizeUsage([
      record({ id: "1", status: "completed" }),
      record({ id: "2", status: "failed" }),
      record({ id: "3", status: "failed" }),
      record({ id: "4", status: "cancelled" }),
      record({ id: "5", status: "unfinished" }),
    ]);
    expect(summary.errorRate).toBe(2 / 3);
    expect(summary.statusCounts).toEqual({ completed: 1, failed: 2, cancelled: 1, unfinished: 1 });

    // 没有分母的错误率是 null，不是 0。
    const empty = summarizeUsage([record({ id: "9", status: "cancelled" })]);
    expect(empty.errorRate).toBeNull();
  });

  it("未采集的用途显式列出，不当 0", () => {
    const summary = summarizeUsage([record({ purpose: "foreground" })]);
    expect(summary.purposeCounts).toEqual([{ purpose: "foreground", records: 1 }]);
    expect(summary.missingPurposes).toEqual(["maintenance", "summary", "proactive"]);
  });

  it("coverage 分布如实可见", () => {
    const summary = summarizeUsage([
      record({ id: "1", coverage: "reported", promptTokens: 1, completionTokens: 1, totalTokens: 2 }),
      record({ id: "2", coverage: "partial", promptTokens: null, completionTokens: null, totalTokens: 5 }),
      record({ id: "3", coverage: "unknown" }),
    ]);
    expect(summary.coverageCounts).toEqual({ reported: 1, partial: 1, unknown: 1 });
  });

  it("时区日界线：同一时刻在 UTC 与 Asia/Shanghai 落在不同日", () => {
    // 2026-01-01 20:00 UTC = 2026-01-02 04:00 +08。
    const at = Date.UTC(2026, 0, 1, 20, 0);
    expect(localDayKey(at, "UTC")).toBe("2026-01-01");
    expect(localDayKey(at, "Asia/Shanghai")).toBe("2026-01-02");

    const summary = summarizeUsage(
      [record({ startedAt: at })],
      { timeZone: "Asia/Shanghai" },
    );
    expect(summary.days.map((day) => day.key)).toEqual(["2026-01-02"]);
  });

  it("非法时区按 UTC 处理，不抛错", () => {
    const summary = summarizeUsage([record()], { timeZone: "Not/AZone" });
    expect(summary.days.map((day) => day.key)).toEqual([localDayKey(BASE, "UTC")]);
  });

  it("费用按币种分开合计，不自动换算；无价目/缺分项计入 unpriced", () => {
    const records = [
      record({ id: "1", promptTokens: 1_000_000, completionTokens: 500_000, totalTokens: 1_500_000, coverage: "reported" }),
      record({ id: "2", providerId: "prov-b", model: "model-b",
        promptTokens: 2_000_000, completionTokens: 0, totalTokens: 2_000_000, coverage: "reported" }),
      // 只有 total：金额未知。
      record({ id: "3", promptTokens: null, completionTokens: null, totalTokens: 999, coverage: "partial" }),
      // 没有价目：金额未知。
      record({ id: "4", providerId: "prov-c", model: "model-c",
        promptTokens: 1, completionTokens: 1, totalTokens: 2, coverage: "reported" }),
    ];
    const prices = [
      price(),
      price({ id: "p2", providerId: "prov-b", model: "model-b", currency: "CNY", inputPerMillion: 5, outputPerMillion: 5 }),
    ];
    const summary = summarizeUsage(records, { prices });

    // input=1M*2 + output=0.5M*8 = 2+4 = 6 USD；prov-b：2M*5 = 10 CNY。互不相加。
    expect(summary.costByCurrency).toEqual({ USD: 6, CNY: 10 });
    expect(summary.unpricedRecords).toBe(2);
    // 未知不能冒充 0：只有 total 的记录 token 合计里出现，但费用里没有。
    expect(summary.tokens.total).toBe(1_500_000 + 2_000_000 + 999 + 2);
  });

  it("显式 0 token 是有效数字，费用按 0 计而不是未知", () => {
    const summary = summarizeUsage(
      [record({ promptTokens: 0, completionTokens: 0, totalTokens: 0, coverage: "reported" })],
      { prices: [price()] },
    );
    expect(summary.costByCurrency).toEqual({ USD: 0 });
    expect(summary.unpricedRecords).toBe(0);
  });

  it("空价目合法：全部金额未知", () => {
    const summary = summarizeUsage(
      [record({ promptTokens: 1, completionTokens: 1, totalTokens: 2, coverage: "reported" })],
      { prices: [] },
    );
    expect(summary.costByCurrency).toEqual({});
    expect(summary.unpricedRecords).toBe(1);
  });

  it("按 provider/model 分组：同模型不同 endpoint 不混", () => {
    const summary = summarizeUsage([
      record({ id: "1", providerId: "prov-a", model: "model-a" }),
      record({ id: "2", providerId: "prov-a", model: "model-a" }),
      record({ id: "3", providerId: "prov-b", model: "model-a" }),
    ]);
    expect(summary.models.map((bucket) => [bucket.key, bucket.records]))
      .toEqual([["prov-a / model-a", 2], ["prov-b / model-a", 1]]);
  });

  it("最慢尝试只用完整计时：补登记（startedAt==endedAt）的不参与（AC-D）", () => {
    const summary = summarizeUsage([
      record({ id: "fast", startedAt: BASE, endedAt: BASE + 100 }),
      // 补登记：有终态没开始，startedAt==endedAt 表示开始时间未知。
      record({ id: "fallback", startedAt: BASE + 5, endedAt: BASE + 5 }),
      record({ id: "slow", startedAt: BASE + 10, endedAt: BASE + 900 }),
      // 没有终态的记录没有完整计时。
      record({ id: "running", startedAt: BASE + 20 }),
    ]);
    expect(summary.slowestAttempt).toEqual({ id: "slow", ms: 890 });
  });

  it("没有完整计时的记录时，最慢尝试是 null 而不是 0", () => {
    const summary = summarizeUsage([record({ id: "x" })]);
    expect(summary.slowestAttempt).toBeNull();
  });
});

describe("usage() 辅助（LLM-12 形状直通）", () => {
  it("分项缺失保持 null 语义", () => {
    const partial = usage(null, null, 5);
    expect(partial.promptTokens).toBeNull();
    expect(partial.totalTokens).toBe(5);
  });
});
