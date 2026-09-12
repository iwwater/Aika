/**
 * Provider 用量台账的数据形状（LLM-12）。
 *
 * 与 TraceTokens（estimatedPrompt/reportedTotal）的区别：台账按**物理请求尝试**记，
 * 带 Provider 配置 ID 与输入/输出分项，成本页才能按输入输出定价。放在 domain：
 * recorder、两个 store 与将来的成本页都要认识这个形状，不该谁为了拿类型去 import
 * HTTP 客户端。
 *
 * 隐私边界：记录**不含**正文、密钥、完整 URL——同模型不同 endpoint 靠稳定的
 * provider 配置 ID 区分。
 */

import type { ProviderUsage } from "./providers";

export const USAGE_LEDGER_SCHEMA_VERSION = 1;

/**
 * 无 scope 记录的分组名（查询用）：老记录与新主体账本不混。
 * 生产装配目前是单主体、不写 scope，所以当前记录全部落在这个分组。
 */
export const USAGE_LEGACY_SCOPE = "legacy";

/** 默认保留期限（天）。查询与落盘都按它截断，成本页必须如实展示覆盖范围。 */
export const DEFAULT_USAGE_RETENTION_DAYS = 30;

/**
 * 这条记录是谁发起的。由实际调用方赋值，不按字符串猜：
 * 前台生成=foreground、记忆抽取=maintenance、滚动摘要=summary、
 * 主动发起=proactive；没经过声明链路的就是 unknown。
 */
export type UsagePurpose = "foreground" | "maintenance" | "summary" | "proactive" | "unknown";

/** 一次物理尝试的终态。unfinished = 开始登记过但终态没等到（进程中断）。 */
export type UsageAttemptStatus = "completed" | "failed" | "cancelled" | "unfinished";

/**
 * 用量的完整度：
 * - reported：prompt/completion/total 三个字段都拿到了（total 可以是两个分项的和，
 *   那是算术不是估计）。
 * - partial：确切上报了一部分（比如只报了 total）。
 * - unknown：一个字段都没有——取消、失败、没发末包 usage。
 */
export type UsageCoverage = "reported" | "partial" | "unknown";

export interface UsageRecordV1 {
  schemaVersion: 1;
  /** attemptId：一次物理请求尝试的主键，幂等 upsert 的键。 */
  id: string;
  /** 同一逻辑请求（含重试/回退的多次尝试）共享。 */
  logicalRequestId: string;
  turnId?: string;
  scope?: string;
  purpose: UsagePurpose;
  /** Provider 配置 ID：区分同模型不同 endpoint 的稳定标识。 */
  providerId: string;
  protocol: string;
  model: string;
  startedAt: number;
  endedAt?: number;
  status: UsageAttemptStatus;
  /** 显式 0 与 unknown 是两回事：0 是平台报了 0，null 是不知道。 */
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  coverage: UsageCoverage;
}

/** 三个字段都非 null 才算 reported；缺任何一个都是部分；全缺是 unknown。 */
export function resolveUsageCoverage(usage: ProviderUsage): UsageCoverage {
  let known = 0;
  if (usage.promptTokens !== null) known += 1;
  if (usage.completionTokens !== null) known += 1;
  if (usage.totalTokens !== null) known += 1;
  if (known === 0) return "unknown";
  if (known === 3) return "reported";
  return "partial";
}

export interface UsageLedgerQuery {
  /** 不传=全部；USAGE_LEGACY_SCOPE=只看无 scope 的记录；其它值=精确匹配。 */
  scope?: string;
  purpose?: UsagePurpose;
  providerId?: string;
  model?: string;
  /** 按 startedAt 过滤（含端点）。 */
  since?: number;
  until?: number;
  /** 单页上限，默认 USAGE_QUERY_DEFAULT_LIMIT。 */
  limit?: number;
  /** 上一页返回的 nextCursor，原样传回。 */
  cursor?: string;
}

export interface UsageLedgerPage {
  records: UsageRecordV1[];
  /** 还有更多时非 null；翻页把它原样传回。 */
  nextCursor: string | null;
  /** 本页之后还有数据没取到——「截断」必须让调用方看得见。 */
  truncated: boolean;
}

export const USAGE_QUERY_DEFAULT_LIMIT = 200;

/** 查询的固定顺序：新的在前；同一时刻按 id 破平，保证翻页稳定。 */
export function compareUsageRecords(a: UsageRecordV1, b: UsageRecordV1): number {
  if (a.startedAt !== b.startedAt) return b.startedAt - a.startedAt;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/**
 * 一次物理请求尝试的用量样本（LLM-12）。started 只报边界；终态把这次尝试**自己**
 * 收到的用量带上——重试/回退是独立的 attempt，台账不能只拿最终合并值。
 * phase 与 RequestMetric.status 同一套词汇。放 domain：recorder 与 providerClient
 * 都要认识它，而 usage 服务不许 import HTTP 客户端模块。
 */
export interface RequestUsageSample {
  logicalRequestId: string;
  attempt: number;
  phase: "started" | "completed" | "failed" | "cancelled";
  /** 终态且平台确实报过字段才携带；没有就是 unknown，不补 0。 */
  usage?: ProviderUsage;
}
