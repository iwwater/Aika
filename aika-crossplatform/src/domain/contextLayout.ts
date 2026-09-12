/**
 * 上下文布局视图（FE-25）。
 *
 * 把 LLM-11 的 context_snapshot 渲染成「逻辑块清单」：块顺序 = ContextAssembler
 * 的装配顺序（必需块 → 历史 → 摘要 → 记忆/知识/环境），**不声称**就是最终
 * Provider 消息顺序；instructionsBlocks 只有协议里存在时才单列最终请求块。
 *
 * 三种状态严格区分：kept（进了上下文）、trimmed（检索到但被裁）、
 * notRetrieved（根本没检索到——绝不伪造进 kept/trimmed）。content=null 表示
 * 「正文未记录」（正文开关关闭），不回查存储绕过开关；未知值显示未知，不推算为 0。
 */

import type { TraceContextSnapshotFields } from "./trace";

export type ContextBlockStatus = "kept" | "trimmed" | "notRetrieved" | "unrecorded";

export interface ContextLayoutBlock {
  /** 逻辑块名：必需块名 / "history" / "summary" / section 名（memory|knowledge|environment）。 */
  name: string;
  ordinal: number;
  estimatedTokens: number | null;
  status: ContextBlockStatus;
  /** trimmed 的原因或 notRetrieved 的说明；kept 为 null。 */
  reason: string | null;
  snippetSource: string | null;
  snippetId: string | null;
  precision: string | null;
  /** 正文；null = 正文未记录（不回查存储）。 */
  content: string | null;
}

export interface ContextLayout {
  /** 旧协议事件没有快照字段：如实显示不支持，不编造。 */
  supported: boolean;
  blocks: ContextLayoutBlock[];
  notes: string[];
}

/** 逻辑块显示名（装配顺序冻结）。 */
export const CONTEXT_BLOCK_ORDER = [
  "characterSoul", "mode", "relationship", "clock", "userSoul", "query",
  "history", "summary", "memory", "knowledge", "environment",
] as const;

export function buildContextLayout(snapshot: TraceContextSnapshotFields | null | undefined): ContextLayout {
  if (!snapshot) {
    return {
      supported: false,
      blocks: [],
      notes: ["这一轮没有上下文快照：旧协议事件或快照未采集，无法显示布局。"],
    };
  }

  const blocks: ContextLayoutBlock[] = [];
  let ordinal = 0;

  for (const required of snapshot.requiredBlocks) {
    blocks.push({
      name: required.name,
      ordinal: ordinal += 1,
      estimatedTokens: required.estimatedTokens,
      status: "kept",
      reason: null,
      snippetSource: null,
      snippetId: null,
      precision: null,
      content: null,
    });
  }

  const history = snapshot.history;
  blocks.push({
    name: "history",
    ordinal: ordinal += 1,
    estimatedTokens: null,
    status: history.kept > 0 ? "kept" : history.normalizedCount > 0 ? "trimmed" : "notRetrieved",
    reason: history.kept > 0
      ? null
      : history.normalizedCount > 0
        ? `normalized ${history.normalizedCount} 条：recentLimit 裁 ${history.recentLimitDropped}、预算裁 ${history.budgetDropped}`
        : "本轮没有历史消息",
    snippetSource: null,
    snippetId: null,
    precision: null,
    content: null,
  });

  blocks.push({
    name: "summary",
    ordinal: ordinal += 1,
    estimatedTokens: snapshot.summary.state === "none" ? null : snapshot.summary.estimatedTokens,
    status: snapshot.summary.state === "used" ? "kept" : "notRetrieved",
    reason: snapshot.summary.state === "skipped" ? "摘要存在但未进入本轮（超预算或未覆盖）" : null,
    snippetSource: null,
    snippetId: null,
    precision: null,
    content: null,
  });

  for (const section of snapshot.sections) {
    if (!section.snippets.length) {
      blocks.push({
        name: section.name,
        ordinal: ordinal += 1,
        estimatedTokens: null,
        status: "notRetrieved",
        reason: "本轮没有检索到任何片段",
        snippetSource: null,
        snippetId: null,
        precision: null,
        content: null,
      });
      continue;
    }
    for (const snippet of section.snippets) {
      blocks.push({
        name: section.name,
        ordinal: ordinal += 1,
        estimatedTokens: snippet.estimatedTokens,
        status: snippet.kept ? "kept" : "trimmed",
        reason: snippet.kept ? null : snippet.reason ?? "trimmed",
        snippetSource: snippet.source,
        snippetId: snippet.id,
        precision: snippet.precision,
        // content=null = 正文未记录（正文开关关闭）。不回查存储绕过开关。
        content: snippet.content,
      });
    }
  }

  const notes: string[] = [];
  if (snapshot.counts.truncated) {
    notes.push(
      `快照被截断：已显示 ${snapshot.counts.snippetsTotal} 条中的清单，遗漏数以 counts 为准（总数 ${snapshot.counts.snippetsTotal}、保留 ${snapshot.counts.snippetsKept}），不是全量清单。`,
    );
  }
  if (snapshot.sections.some((section) => section.snippets.some((snippet) => snippet.content === null && snippet.kept))) {
    notes.push("正文未记录：正文开关是关的，这里不回查存储绕过开关。");
  }

  return { supported: true, blocks, notes };
}
