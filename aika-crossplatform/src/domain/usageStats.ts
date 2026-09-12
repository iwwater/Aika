/**
 * F9 成本页的统计纯函数（FE-26）。
 *
 * 输入是用量台账的记录（LLM-12 UsageRecordV1）与**显式提供**的版本化价目，输出
 * 是可直接渲染的汇总。三条红线：
 *
 * 1. **不用估算兜账单**。没有分项、没有价目、没有用途，就显示未知——
 *    `estimatedPrompt` 是上下文装配的估算值，永远不进这里。
 * 2. **不发明汇率**。不同币种分开合计，绝不互相换算。
 * 3. **重复事件幂等**。同一 attemptId 出现多次（上游重发、分页重叠）只算一次。
 */

import {
  type UsageCoverage, type UsagePurpose, type UsageRecordV1,
} from "./usageLedger";

export const PRICING_SCHEMA_VERSION = 1;

/** 一条价目。每百万 token 的单价由使用者显式输入，本仓不内置任何实时价。 */
export interface PriceEntryV1 {
  /** 稳定 id：编辑/删除的定位键，由保存方生成。 */
  id: string;
  model: string;
  providerId: string;
  /** 显式币种（如 "USD" / "CNY"）。不同币种分开合计，不自动换算。 */
  currency: string;
  /** 生效日（YYYY-MM-DD，含当天）。同模型多条价目时取「不晚于记录当日」的最新一条。 */
  effectiveFrom: string;
  inputPerMillion: number;
  outputPerMillion: number;
}

export interface PricingConfigV1 {
  schemaVersion: 1;
  /** 保存时间：只作版本标识，不参与计价。 */
  savedAt: number;
  prices: PriceEntryV1[];
}

export function validatePriceEntry(entry: PriceEntryV1): string | null {
  if (!entry.model.trim()) return "缺少模型名";
  if (!entry.providerId.trim()) return "缺少 Provider 标识";
  if (!entry.currency.trim()) return "缺少币种";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.effectiveFrom)) return "生效日必须是 YYYY-MM-DD";
  for (const [label, value] of [["输入", entry.inputPerMillion], ["输出", entry.outputPerMillion]] as const) {
    if (typeof value !== "number" || !Number.isFinite(value)) return `${label}单价必须是数字`;
    if (value < 0) return `${label}单价不能为负`;
  }
  return null;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 选一条记录适用的价目：providerId+model 精确匹配，生效日不晚于记录当日
 * （与展示同一时区归日），多条取生效日最新；同日并列取先出现的一条。
 * 匹配不到就返回 null——没有价目的金额是未知，不是 0。
 */
export function priceForRecord(
  prices: readonly PriceEntryV1[],
  record: UsageRecordV1,
  timeZone = "UTC",
): PriceEntryV1 | null {
  const day = localDayKey(record.startedAt, timeZone);
  let best: PriceEntryV1 | null = null;
  for (const price of prices) {
    if (price.providerId !== record.providerId || price.model !== record.model) continue;
    if (!DAY_RE.test(price.effectiveFrom) || price.effectiveFrom > day) continue;
    if (!best || price.effectiveFrom > best.effectiveFrom) best = price;
  }
  return best;
}

/**
 * 单条记录的费用。输入/输出分别乘各自单价再相加——只报 total 的记录不拆分、
 * 不计价（金额未知）。缓存分项当前台账未采集，无法计价也不重复计价。
 * 金额按 9 位小数舍入：价目小时（如 0.1/百万）6 位会把真实费用抹成 0。
 */
export function recordCost(record: UsageRecordV1, price: PriceEntryV1): number | null {
  if (record.promptTokens === null || record.completionTokens === null) return null;
  const cost = (record.promptTokens / 1_000_000) * price.inputPerMillion
    + (record.completionTokens / 1_000_000) * price.outputPerMillion;
  return roundMoney(cost);
}

function roundMoney(value: number): number {
  return Math.round(value * 1_000_000_000) / 1_000_000_000;
}

/** 用户所选时区的日界线：时间戳 → YYYY-MM-DD（本地日）。 */
export function localDayKey(startedAt: number, timeZone: string): string {
  try {
    // en-CA 的日期格式恰好是 YYYY-MM-DD。
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date(startedAt));
  } catch {
    // 未知时区退回 UTC，如实可比"猜一个本地日"可靠。
    return new Date(startedAt).toISOString().slice(0, 10);
  }
}

/** 非法时区交给 Intl 判断；这里只挡空串。 */
export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone });
    return true;
  } catch {
    return false;
  }
}

export interface UsageTokens {
  /** 只合计平台确报的值；一个都没有就是 null，不写 0。 */
  prompt: number | null;
  completion: number | null;
  total: number | null;
}

export interface UsageBucket {
  key: string;
  records: number;
  tokens: UsageTokens;
  /** 币种 → 金额（6 位小数）。只含有价目且分项齐全的记录。 */
  costByCurrency: Record<string, number>;
  /** 有记录但没算出金额的条数（缺价目或缺分项）。 */
  unpricedRecords: number;
}

export interface UsageStatsSummary {
  /** 幂等去重后的记录数。 */
  records: number;
  /** 上游重复出现被吸收的条数（按 attemptId）。 */
  duplicatesAbsorbed: number;
  statusCounts: { completed: number; failed: number; cancelled: number; unfinished: number };
  /** failed/(completed+failed)；分母为 0 时是 null——没有分母的错误率不是 0。 */
  errorRate: number | null;
  /** 全量 token 合计（null 感知）。 */
  tokens: UsageTokens;
  /** coverage 分布：reported/partial/unknown 各多少条。 */
  coverageCounts: Record<UsageCoverage, number>;
  /** 实际出现过的用途及条数。 */
  purposeCounts: { purpose: UsagePurpose; records: number }[];
  /** 已声明用途里没有任何记录的——「未采集」必须与 0 区分。 */
  missingPurposes: UsagePurpose[];
  /** 按所选时区日界线分组，旧→新。 */
  days: UsageBucket[];
  /** 按 provider+model 分组，条数降序。 */
  models: UsageBucket[];
  costByCurrency: Record<string, number>;
  unpricedRecords: number;
  /**
   * 最慢的一次物理尝试。**只统计有真实开始登记的记录**（endedAt > startedAt）：
   * startedAt==endedAt 是「有终态没开始」的补登记，开始时间未知——
   * 把它当成 0 耗时或完整计时都是在发明。
   */
  slowestAttempt: { id: string; turnId?: string; ms: number } | null;
}

const DECLARED_PURPOSES: UsagePurpose[] = ["foreground", "maintenance", "summary", "proactive"];

function emptyTokens(): UsageTokens {
  return { prompt: null, completion: null, total: null };
}

/** null 感知的合计：两侧都未知保持未知；已知侧照常累加。 */
function addTokens(base: UsageTokens, record: UsageRecordV1): void {
  if (record.promptTokens !== null) base.prompt = (base.prompt ?? 0) + record.promptTokens;
  if (record.completionTokens !== null) base.completion = (base.completion ?? 0) + record.completionTokens;
  if (record.totalTokens !== null) base.total = (base.total ?? 0) + record.totalTokens;
}

function bucketOf(buckets: Map<string, UsageBucket>, key: string): UsageBucket {
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { key, records: 0, tokens: emptyTokens(), costByCurrency: {}, unpricedRecords: 0 };
    buckets.set(key, bucket);
  }
  return bucket;
}

export interface SummarizeUsageOptions {
  /** 版本化价目。空价目合法——全部金额如实显示未知。 */
  prices?: readonly PriceEntryV1[];
  /** 日界线时区；默认 UTC。非法时区按 UTC 处理。 */
  timeZone?: string;
}

export function summarizeUsage(
  rawRecords: readonly UsageRecordV1[],
  options: SummarizeUsageOptions = {},
): UsageStatsSummary {
  const timeZone = options.timeZone && isValidTimeZone(options.timeZone) ? options.timeZone : "UTC";
  const prices = options.prices ?? [];

  // 幂等：同一 attemptId 只算一次，后出现的覆盖先出现的（与台账 upsert 同向）。
  const byId = new Map<string, UsageRecordV1>();
  let duplicatesAbsorbed = 0;
  for (const record of rawRecords) {
    if (byId.has(record.id)) duplicatesAbsorbed += 1;
    byId.set(record.id, record);
  }
  const records = [...byId.values()];

  const statusCounts = { completed: 0, failed: 0, cancelled: 0, unfinished: 0 };
  const coverageCounts: Record<UsageCoverage, number> = { reported: 0, partial: 0, unknown: 0 };
  const purposeMap = new Map<UsagePurpose, number>();
  const dayBuckets = new Map<string, UsageBucket>();
  const modelBuckets = new Map<string, UsageBucket>();
  const tokens = emptyTokens();
  const costByCurrency: Record<string, number> = {};
  let unpricedRecords = 0;
  let slowestAttempt: UsageStatsSummary["slowestAttempt"] = null;

  for (const record of records) {
    statusCounts[record.status] += 1;
    coverageCounts[record.coverage] += 1;
    purposeMap.set(record.purpose, (purposeMap.get(record.purpose) ?? 0) + 1);
    addTokens(tokens, record);

    // 最慢尝试只用「开始与结束都真实观测到」的记录（AC-D：只用完整计时）。
    if (record.endedAt !== undefined && record.endedAt > record.startedAt) {
      const ms = record.endedAt - record.startedAt;
      if (!slowestAttempt || ms > slowestAttempt.ms) {
        slowestAttempt = { id: record.id, ...(record.turnId ? { turnId: record.turnId } : {}), ms };
      }
    }

    const price = priceForRecord(prices, record, timeZone);
    const cost = price ? recordCost(record, price) : null;
    if (price && cost !== null) {
      costByCurrency[price.currency] = roundMoney((costByCurrency[price.currency] ?? 0) + cost);
    } else {
      unpricedRecords += 1;
    }

    const day = bucketOf(dayBuckets, localDayKey(record.startedAt, timeZone));
    day.records += 1;
    addTokens(day.tokens, record);
    if (price && cost !== null) {
      day.costByCurrency[price.currency] = roundMoney((day.costByCurrency[price.currency] ?? 0) + cost);
    } else {
      day.unpricedRecords += 1;
    }

    const model = bucketOf(modelBuckets, `${record.providerId} / ${record.model}`);
    model.records += 1;
    addTokens(model.tokens, record);
    if (price && cost !== null) {
      model.costByCurrency[price.currency] = roundMoney((model.costByCurrency[price.currency] ?? 0) + cost);
    } else {
      model.unpricedRecords += 1;
    }
  }

  const errorDenominator = statusCounts.completed + statusCounts.failed;
  return {
    records: records.length,
    duplicatesAbsorbed,
    statusCounts,
    errorRate: errorDenominator === 0 ? null : statusCounts.failed / errorDenominator,
    tokens,
    coverageCounts,
    purposeCounts: [...purposeMap.entries()]
      .map(([purpose, count]) => ({ purpose, records: count }))
      .sort((a, b) => a.purpose.localeCompare(b.purpose)),
    missingPurposes: DECLARED_PURPOSES.filter((purpose) => !purposeMap.has(purpose)),
    days: [...dayBuckets.values()].sort((a, b) => a.key.localeCompare(b.key)),
    models: [...modelBuckets.values()].sort((a, b) => b.records - a.records),
    costByCurrency,
    unpricedRecords,
    slowestAttempt,
  };
}
