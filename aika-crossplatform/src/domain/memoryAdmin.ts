/**
 * 记忆管理页的判定（F7）。
 *
 * 右栏那份列表看的是 `toLegacyMemoryRecord()` 的结果：type 被压成 5 个旧 category、
 * `candidate/superseded` 被压成 `pending`、来源与置信度整个丢掉。管理一条记忆需要
 * 知道的恰恰是被压掉的那些——**这句话从哪来、还能不能当真、是不是已经被取代了**。
 * 所以这里直接吃 `MemoryRecordV2`，不走降级。
 *
 * 两条规矩：
 * - **不伪造来源**。迁移来的记录 `sourceMessageIds` 一律为空（LLM-03 的决定），
 *   这里就显示「来源不明」，不编一个。
 * - **「筛没了」与「一条都没有」是两回事**。前者改筛选条件就能看见，后者要先聊天。
 */

import {
  MEMORY_STATUS_V2, MEMORY_TYPES, memoryContentHash,
  type MemoryRecordV2, type MemorySourceKind, type MemoryStatusV2, type MemoryType,
} from "./memory";
import { MEMORY_TYPE_LABELS } from "./memoryRetrieval";

export interface MemoryFilter {
  /** null = 不按类型筛。 */
  type: MemoryType | null;
  status: MemoryStatusV2 | null;
  /** 搜索词；空串表示不搜。 */
  text: string;
  /** 被取代的记录默认不列：它们不参与检索，列出来只会让人以为记了两遍。 */
  includeSuperseded: boolean;
}

export const DEFAULT_MEMORY_FILTER: MemoryFilter = {
  type: null, status: null, text: "", includeSuperseded: false,
};

export interface MemoryRow {
  record: MemoryRecordV2;
  typeLabel: string;
  statusLabel: string;
  /** 来源一句话。不伪造：来源不明就说不明。 */
  sourceLabel: string;
  /** 置信度百分比；未知是 null，不写 0——「不知道」不是「不可信」。 */
  confidencePercent: number | null;
  /** 有效期提示；没有时限时为 null。 */
  validityNote: string | null;
  /** 这条取代了哪一条（如果那条还在库里）。 */
  supersedesContent: string | null;
  /** 待过目：审核流要把它们挑出来置顶。 */
  needsReview: boolean;
}

export const MEMORY_STATUS_LABELS: Record<MemoryStatusV2, string> = {
  candidate: "待过目",
  confirmed: "已确认",
  superseded: "已被取代",
};

export const MEMORY_SOURCE_LABELS: Record<MemorySourceKind, string> = {
  messages: "来自对话",
  "external-bound": "绑定外部主体（未核归属）",
  "untrusted-material": "不可信资料（群聊/引文/Agent）",
  legacy: "来源不明（迁移自旧版）",
  userEdit: "你写的",
};

export { MEMORY_TYPE_LABELS, MEMORY_TYPES, MEMORY_STATUS_V2 };

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, "");
}

function sourceLabel(record: MemoryRecordV2): string {
  if (record.sourceKind === "messages") {
    // 来源条数是真的；没有 id 的 messages 记录同样不编，直说来源没留下。
    return record.sourceMessageIds.length
      ? `来自对话 · ${record.sourceMessageIds.length} 条来源消息`
      : "来自对话 · 来源没留下";
  }
  return MEMORY_SOURCE_LABELS[record.sourceKind];
}

function validityNote(record: MemoryRecordV2, now: number): string | null {
  if (record.validUntil !== null && record.validUntil <= now) return "已过期";
  if (record.validFrom !== null && record.validFrom > now) return "尚未生效";
  if (record.validUntil !== null) return "有时限";
  return null;
}

/** 一条记忆在管理页上的样子。组件不做任何判断，只画这里算好的字段。 */
export function toMemoryRow(
  record: MemoryRecordV2,
  all: readonly MemoryRecordV2[],
  now: number,
): MemoryRow {
  const superseded = record.supersedesId
    ? all.find((item) => item.id === record.supersedesId) ?? null
    : null;
  return {
    record,
    typeLabel: MEMORY_TYPE_LABELS[record.type],
    statusLabel: MEMORY_STATUS_LABELS[record.status],
    sourceLabel: sourceLabel(record),
    confidencePercent: record.confidence === null ? null : Math.round(record.confidence * 100),
    validityNote: validityNote(record, now),
    supersedesContent: superseded?.content ?? null,
    needsReview: record.status === "candidate",
  };
}

/**
 * 筛选 + 排序。
 *
 * 排序口径：待过目的在最前（审核流的入口就是这一屏），其余按更新时间倒序。
 * 同一批里时间相同的按 id 稳定排，避免每次刷新顺序跳来跳去。
 */
export function filterMemories(
  records: readonly MemoryRecordV2[],
  filter: MemoryFilter,
  now: number = Date.now(),
): MemoryRow[] {
  const needle = normalize(filter.text);
  return records
    .filter((record) => {
      if (!filter.includeSuperseded && record.status === "superseded") return false;
      if (filter.type && record.type !== filter.type) return false;
      if (filter.status && record.status !== filter.status) return false;
      if (needle && !normalize(record.content).includes(needle)) return false;
      return true;
    })
    .map((record) => toMemoryRow(record, records, now))
    .sort((left, right) => (
      Number(right.needsReview) - Number(left.needsReview)
      || right.record.updatedAt - left.record.updatedAt
      || left.record.id.localeCompare(right.record.id)
    ));
}

/** 空状态有两种，别混成一句「没有记忆」。 */
export type MemoryEmptyKind = "none" | "filtered" | null;

export function emptyKind(total: number, visible: number): MemoryEmptyKind {
  if (visible > 0) return null;
  return total === 0 ? "none" : "filtered";
}

export interface MemoryEdit {
  content: string;
  type: MemoryType;
}

/**
 * 把一次编辑落成新记录。
 *
 * - 正文被改过 → `sourceKind: userEdit`：用户亲手写的允许在删除后重新记住
 *   （仓储的抑制规则对 `userEdit` 网开一面），这个标记不能省。
 * - 编辑等于用户过目了 → `confirmed` + `lastConfirmedAt`。
 * - `createdAt` 不动：这条记忆是什么时候开始存在的，不因为改了个错字而改变。
 * - 正文为空 → 返回 null，调用方不写盘。删一条记忆要走删除，不是清空正文。
 */
export function applyMemoryEdit(
  record: MemoryRecordV2,
  edit: MemoryEdit,
  now: number = Date.now(),
): MemoryRecordV2 | null {
  const content = edit.content.trim();
  if (!content) return null;
  const contentChanged = memoryContentHash(content) !== memoryContentHash(record.content);
  return {
    ...record,
    content,
    type: edit.type,
    sourceKind: contentChanged ? "userEdit" : record.sourceKind,
    status: "confirmed",
    lastConfirmedAt: now,
    createdAt: record.createdAt,
    updatedAt: now,
  };
}

/** 确认一条：只改状态与确认时间，不碰正文、来源与创建时间。 */
export function confirmMemoryRecord(record: MemoryRecordV2, now: number = Date.now()): MemoryRecordV2 {
  return { ...record, status: "confirmed", lastConfirmedAt: now, updatedAt: now };
}

export interface BatchOutcome {
  ok: number;
  failed: number;
  /** 失败的条目与原因，用来在界面上说清楚「哪几条没成」。 */
  errors: { id: string; message: string }[];
}

export function emptyBatchOutcome(): BatchOutcome {
  return { ok: 0, failed: 0, errors: [] };
}

/**
 * 批量结果的一句话。
 *
 * 仓储只有逐条 `forget`，批量不是事务，所以「删了 3 条、2 条失败」必须说出来——
 * 显示成全成功会让人以为库里已经干净了。
 */
export function batchSummary(action: string, outcome: BatchOutcome): string {
  if (!outcome.failed) return `${action}了 ${outcome.ok} 条`;
  if (!outcome.ok) return `${outcome.failed} 条都没能${action}：${outcome.errors[0]?.message ?? "未知原因"}`;
  return `${action}了 ${outcome.ok} 条，${outcome.failed} 条失败：${outcome.errors[0]?.message ?? "未知原因"}`;
}
