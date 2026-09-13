import { describe, expect, it } from "vitest";
import { createManualClock } from "./fakeEnvironment";
import {
  CONFIDENCE_WITHOUT_WORD_LEVEL,
  matchKeywords,
  normalizeWordConfidence,
} from "./keywordRules";

/**
 * FE-21 词表规则：独立词边界、大小写无关、词表 ID、置信度归一。
 */

describe("matchKeywords（FE-21-A 规则层）", () => {
  it("五词命中正确的 kind 与 event", () => {
    const cases: Array<[string, string, "game_event" | "screen_keyword", string]> = [
      ["VICTORY", "victory", "game_event", "victory"],
      ["a huge DEFEAT screen", "defeat", "game_event", "defeat"],
      ["PENTAKILL!!!", "pentakill", "game_event", "pentakill"],
      ["some Error happened", "error", "screen_keyword", "error"],
      ["Build FAILED", "failed", "screen_keyword", "failed"],
    ];
    for (const [text, ruleId, kind, event] of cases) {
      const matches = matchKeywords(text, null);
      const match = matches.find((m) => m.ruleId === ruleId);
      expect(match, text).toBeDefined();
      expect(match?.kind).toBe(kind);
      expect(match?.event).toBe(event);
    }
  });

  it("近拼写不误报（ERRORS/FAILURES/DEFEATED/PENTAKILLED/VICTORS 不命中）", () => {
    for (const text of ["ERRORS: 3", "FAILURES 0", "DEFEATED", "PENTAKILLED them", "VICTORS list", "Failures: none"]) {
      expect(matchKeywords(text, null)).toEqual([]);
    }
  });

  it("大小写无关；同 ruleId 只报一次", () => {
    const matches = matchKeywords("error ERROR Error", null);
    expect(matches).toHaveLength(1);
    expect(matches[0].ruleId).toBe("error");
  });

  it("无词级置信度时用保守缺省（不造 1.0）", () => {
    const matches = matchKeywords("VICTORY", null);
    expect(matches[0].confidence).toBe(CONFIDENCE_WITHOUT_WORD_LEVEL);
    expect(matches[0].confidence).toBeLessThan(0.8);
  });

  it("词级置信度归一化：tesseract 0..100 → 0..1；非有限数按无证据", () => {
    expect(normalizeWordConfidence(92)).toBeCloseTo(0.92);
    expect(normalizeWordConfidence(0)).toBe(0);
    expect(normalizeWordConfidence(Number.NaN)).toBe(CONFIDENCE_WITHOUT_WORD_LEVEL);
    const matches = matchKeywords("victory", new Map([["victory", normalizeWordConfidence(93)]]));
    expect(matches[0].confidence).toBeCloseTo(0.93);
  });
});

// 手动时钟在本文件只被需要时使用（保持导入对齐）。
void createManualClock;
