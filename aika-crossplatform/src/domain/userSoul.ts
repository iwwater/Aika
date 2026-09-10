/**
 * User Soul 的沉淀规则。
 *
 * 画像只写「用户说了算」的东西，所以门槛写在两处：
 *
 * 1. **自动晋升需要两个独立来源。** 一句「我喜欢咖啡」可能只是随口一提；
 *    两次不同消息里都出现，才算稳定事实。同一批次重放不算第二份证据——
 *    那只是同一句话被处理了两遍。
 * 2. **置信度不等于确认。** 候选可以带着来源留在画像里，但在拿到第二份
 *    证据或用户亲口纠正之前，它不能进提示词，也不能被说成「我记得」。
 *
 * 用户明确纠正永远优先：她说「不对，我不喝咖啡了」，这条立刻生效，
 * 旧来源保留在 sources 里以便追溯，但不再作为当前事实。
 */

import type { SourcedValue, SourceRef, UserSoul } from "./soul";

export const USER_SOUL_FIELDS = [
  "stableFacts",
  "preferences",
  "dislikes",
  "goals",
  "habits",
  "importantPeople",
  "communicationPreferences",
] as const;

export type UserSoulField = (typeof USER_SOUL_FIELDS)[number];

const EMPTY_FIELDS: Pick<UserSoul, UserSoulField> = {
  stableFacts: [],
  preferences: [],
  dislikes: [],
  goals: [],
  habits: [],
  importantPeople: [],
  communicationPreferences: [],
};

export type SoulEntryStatus = "candidate" | "confirmed";

export interface SoulEvidence {
  field: UserSoulField;
  value: string;
  /** 支持这条事实的消息 id；两个不同 id 才构成两份独立证据。 */
  sourceMessageIds: readonly string[];
  /** userEdit 表示用户亲手写的，直接生效，不需要第二份证据。 */
  sourceKind?: "messages" | "userEdit" | "imported";
  now?: number;
}

export interface SoulChange {
  soul: UserSoul;
  changed: boolean;
  status: SoulEntryStatus;
  reason: string;
}

function normalizeValue(value: string): string {
  return (value ?? "").trim().toLowerCase().replace(/[\s，。、,.!！?？~～]/g, "");
}

function sameValue(left: string, right: string): boolean {
  const a = normalizeValue(left);
  const b = normalizeValue(right);
  return a.length > 0 && a === b;
}

function isUserSource(source: SourceRef): boolean {
  return source.kind === "user";
}

function messageSourceIds(entry: SourcedValue): string[] {
  return [...new Set(
    entry.sources
      .filter((source) => source.kind === "message" && source.reference)
      .map((source) => source.reference as string),
  )];
}

/**
 * 一条画像条目算不算已确认。
 *
 * 用户来源 → 直接确认；两个及以上不同消息来源 → 确认；其余是候选。
 * 置信度高低不影响这个判断。
 */
export function soulEntryStatus(entry: SourcedValue): SoulEntryStatus {
  if (entry.sources.some(isUserSource)) return "confirmed";
  if (messageSourceIds(entry).length >= 2) return "confirmed";
  return "candidate";
}

/** 只把已确认的部分交给提示词：候选不能冒充「我记得」。 */
export function confirmedUserSoul(soul: UserSoul): UserSoul {
  const result: UserSoul = { schemaVersion: 1, ...EMPTY_FIELDS };
  for (const field of USER_SOUL_FIELDS) {
    result[field] = soul[field].filter((entry) => soulEntryStatus(entry) === "confirmed");
  }
  return result;
}

function cloneSoul(soul: UserSoul): UserSoul {
  const next: UserSoul = { schemaVersion: 1, ...EMPTY_FIELDS };
  for (const field of USER_SOUL_FIELDS) {
    next[field] = soul[field].map((entry) => ({ ...entry, sources: [...entry.sources] }));
  }
  return next;
}

/**
 * 追加一份证据。
 *
 * 同值条目已存在时只补来源，不新建条目——否则同一句话会堆出一串重复画像。
 * 来源按 reference 去重，所以同一条消息重放两次不会凑成两份证据。
 */
export function applySoulEvidence(soul: UserSoul, evidence: SoulEvidence): SoulChange {
  const value = (evidence.value ?? "").trim();
  if (!value) return { soul, changed: false, status: "candidate", reason: "空值不写入画像" };

  const now = evidence.now ?? Date.now();
  const next = cloneSoul(soul);
  const entries = next[evidence.field];
  const existing = entries.find((entry) => sameValue(entry.value, value));
  const kind: SourceRef["kind"] = evidence.sourceKind === "userEdit" ? "user"
    : evidence.sourceKind === "imported" ? "imported"
      : "message";

  const incoming: SourceRef[] = evidence.sourceMessageIds
    .filter((id) => typeof id === "string" && id.length > 0)
    .map((id) => ({ kind: "message" as const, reference: id, capturedAt: now }));

  if (kind === "user") incoming.push({ kind: "user", capturedAt: now });
  if (kind === "imported" && !incoming.length) incoming.push({ kind: "imported", capturedAt: now });

  if (!existing) {
    entries.push({ value, sources: incoming });
    const status = soulEntryStatus(entries[entries.length - 1]);
    return {
      soul: next,
      changed: true,
      status,
      reason: status === "confirmed" ? "用户来源或已有足够证据，直接沉淀" : "单份证据，先记为候选",
    };
  }

  const known = new Set(existing.sources.map((source) => `${source.kind}:${source.reference ?? ""}`));
  let added = 0;
  for (const source of incoming) {
    const key = `${source.kind}:${source.reference ?? ""}`;
    if (known.has(key)) continue;
    known.add(key);
    existing.sources.push(source);
    added += 1;
  }
  if (!added) {
    return { soul, changed: false, status: soulEntryStatus(existing), reason: "来源重复，不算新证据" };
  }

  const status = soulEntryStatus(existing);
  return {
    soul: next,
    changed: true,
    status,
    reason: status === "confirmed" ? "两份独立证据，晋升为已确认" : "新增来源，仍为候选",
  };
}

export interface SoulCorrection {
  field: UserSoulField;
  /** 被纠正的旧说法；为空表示纯新增。 */
  from?: string;
  to: string;
  now?: number;
  /** 纠正时保留的原来源消息，便于追溯。 */
  keepSourceMessageIds?: readonly string[];
}

/**
 * 用户明确纠正。
 *
 * 旧条目的来源全部保留（只把值换成新的），新值带 user 来源因此立即确认；
 * 这样既尊重用户的最新说法，也留得下「她以前是怎么说的」。
 */
export function applySoulCorrection(soul: UserSoul, correction: SoulCorrection): SoulChange {
  const to = (correction.to ?? "").trim();
  if (!to) return { soul, changed: false, status: "candidate", reason: "空值不写入画像" };

  const now = correction.now ?? Date.now();
  const next = cloneSoul(soul);
  const entries = next[correction.field];
  const from = (correction.from ?? "").trim();
  const keptSources: SourceRef[] = [];

  if (from) {
    const index = entries.findIndex((entry) => sameValue(entry.value, from));
    if (index >= 0) {
      keptSources.push(...entries[index].sources);
      entries.splice(index, 1);
    }
  }
  for (const id of correction.keepSourceMessageIds ?? []) {
    keptSources.push({ kind: "message", reference: id, capturedAt: now });
  }

  const target = entries.find((entry) => sameValue(entry.value, to));
  const correctionSource: SourceRef = { kind: "user", capturedAt: now };
  if (target) {
    const known = new Set(target.sources.map((source) => `${source.kind}:${source.reference ?? ""}`));
    for (const source of [...keptSources, correctionSource]) {
      const key = `${source.kind}:${source.reference ?? ""}`;
      if (known.has(key)) continue;
      known.add(key);
      target.sources.push(source);
    }
    return { soul: next, changed: true, status: soulEntryStatus(target), reason: "用户纠正已生效，来源保留" };
  }

  entries.push({ value: to, sources: [...keptSources, correctionSource] });
  const created = entries[entries.length - 1];
  return { soul: next, changed: true, status: soulEntryStatus(created), reason: "用户纠正已生效，来源保留" };
}

/**
 * 删除记忆后的联动：把引用了这些消息来源的画像条目降级/移除。
 *
 * 用户删掉的记忆不能再从画像里冒出来。条目若还留有其它来源就只摘掉这些来源，
 * 一个来源都不剩时整条移除。
 */
export function dropSoulSources(soul: UserSoul, messageIds: readonly string[]): { soul: UserSoul; changed: boolean; removed: number } {
  const ids = new Set(messageIds.filter((id) => typeof id === "string" && id.length > 0));
  if (!ids.size) return { soul, changed: false, removed: 0 };

  const next = cloneSoul(soul);
  let changed = false;
  let removed = 0;
  for (const field of USER_SOUL_FIELDS) {
    const kept: SourcedValue[] = [];
    for (const entry of next[field]) {
      const remaining = entry.sources.filter((source) => !(
        source.kind === "message" && source.reference && ids.has(source.reference)
      ));
      if (remaining.length === entry.sources.length) {
        kept.push(entry);
        continue;
      }
      changed = true;
      if (remaining.length) {
        kept.push({ ...entry, sources: remaining });
      } else {
        removed += 1;
      }
    }
    next[field] = kept;
  }
  return { soul: next, changed, removed };
}

/** 画像里已确认事实的清单，供提示词与调试使用。 */
export function describeUserSoul(soul: UserSoul): string[] {
  const confirmed = confirmedUserSoul(soul);
  const lines: string[] = [];
  for (const field of USER_SOUL_FIELDS) {
    for (const entry of confirmed[field]) lines.push(`${field}: ${entry.value}`);
  }
  return lines;
}
