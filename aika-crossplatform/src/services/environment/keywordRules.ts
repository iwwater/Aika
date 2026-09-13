/**
 * 屏幕关键词规则（FE-21）。
 *
 * 首版固定英文词表（2026-09-14 修订冻结）：VICTORY / DEFEAT / PENTAKILL →
 * `game_event`；Error / Failed → `screen_keyword`。按独立词边界、大小写无关匹配。
 * **中文不列支持**：中文词表可保留历史条目形态，但首版不提供中文 OCR，不得宣称。
 */

export type ScreenEventKind = "game_event" | "screen_keyword";

export interface KeywordRule {
  /** 词表 ID：recent/context/policy 只引用它，不引用 OCR 原文。 */
  ruleId: string;
  pattern: RegExp;
  kind: ScreenEventKind;
  /** 事件词汇名（game_event 的 event / screen_keyword 的 keyword）。 */
  event: string;
}

export const DEFAULT_KEYWORD_RULES: readonly KeywordRule[] = [
  { ruleId: "victory", pattern: /\bvictory\b/i, kind: "game_event", event: "victory" },
  { ruleId: "defeat", pattern: /\bdefeat\b/i, kind: "game_event", event: "defeat" },
  { ruleId: "pentakill", pattern: /\bpentakill\b/i, kind: "game_event", event: "pentakill" },
  { ruleId: "error", pattern: /\berror\b/i, kind: "screen_keyword", event: "error" },
  { ruleId: "failed", pattern: /\bfailed\b/i, kind: "screen_keyword", event: "failed" },
];

/**
 * 词级置信度缺失时的保守缺省：不是 1.0——没有证据就不冒充高置信度。
 * （FE-22 的 game_event 触发要求 confidence ≥0.8：缺词级证据的事件过不了线，
 * 这是设计行为而不是缺陷。）
 */
export const CONFIDENCE_WITHOUT_WORD_LEVEL = 0.5;

export interface KeywordMatch {
  ruleId: string;
  kind: ScreenEventKind;
  event: string;
  /** 归一化到 0..1；来源为词级置信度或保守缺省。 */
  confidence: number;
}

/** tesseract 词置信度 0..100 → 0..1；非有限数按无证据处理。 */
export function normalizeWordConfidence(raw: number | undefined | null): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return CONFIDENCE_WITHOUT_WORD_LEVEL;
  return Math.max(0, Math.min(1, raw / 100));
}

/**
 * 对 OCR 文本跑词表。返回去重后的命中（同一 ruleId 只报一次）。
 * `wordConfidence` 是「归一化后的词 → 置信度」查找表；无词级数据传 null。
 */
export function matchKeywords(
  text: string,
  wordConfidence: ReadonlyMap<string, number> | null,
  rules: readonly KeywordRule[] = DEFAULT_KEYWORD_RULES,
): KeywordMatch[] {
  const matches: KeywordMatch[] = [];
  const seen = new Set<string>();
  for (const rule of rules) {
    if (seen.has(rule.ruleId)) continue;
    const match = rule.pattern.exec(text);
    if (!match) continue;
    seen.add(rule.ruleId);
    // 词级置信度优先用命中的那个词；找不到词条目（跨行合并等）用保守缺省。
    const matchedWord = match[0].toLowerCase();
    const confidence = wordConfidence?.get(matchedWord) ?? CONFIDENCE_WITHOUT_WORD_LEVEL;
    matches.push({ ruleId: rule.ruleId, kind: rule.kind, event: rule.event, confidence });
  }
  return matches;
}
