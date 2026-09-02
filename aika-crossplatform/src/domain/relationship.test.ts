import { describe, expect, it } from "vitest";
import {
  computeRelationship,
  deriveRelationshipSignals,
  EMPTY_RELATIONSHIP_SIGNALS,
} from "./relationship";

const DAY = 24 * 60 * 60 * 1000;

/** 固定在本地时间中午，避免时区把时间戳推到相邻日历日。 */
function noonDaysAgo(days: number, base = new Date(2026, 8, 2, 12, 0, 0)): number {
  return base.getTime() - days * DAY;
}

describe("computeRelationship", () => {
  it("没有互动时是新关系", () => {
    expect(computeRelationship(EMPTY_RELATIONSHIP_SIGNALS).stage).toBe("new");
  });

  it("一天狂聊一百条不等于认识三个月", () => {
    const burst = computeRelationship({ daysKnown: 0, consecutiveActiveDays: 1, totalMessageCount: 100 });
    const longAcquaintance = computeRelationship({ daysKnown: 90, consecutiveActiveDays: 1, totalMessageCount: 40 });
    expect(burst.stage).toBe("new");
    expect(longAcquaintance.stage).toBe("familiar");
    expect(longAcquaintance.familiarity).toBeGreaterThan(burst.familiarity);
  });

  it("三个因子都到位才算亲近", () => {
    expect(computeRelationship({ daysKnown: 90, consecutiveActiveDays: 7, totalMessageCount: 300 }).stage).toBe("close");
  });

  it("任何单一因子拉满都到不了亲近", () => {
    expect(computeRelationship({ daysKnown: 3650, consecutiveActiveDays: 0, totalMessageCount: 0 }).stage).not.toBe("close");
    expect(computeRelationship({ daysKnown: 0, consecutiveActiveDays: 365, totalMessageCount: 0 }).stage).not.toBe("close");
    expect(computeRelationship({ daysKnown: 0, consecutiveActiveDays: 0, totalMessageCount: 10_000 }).stage).not.toBe("close");
  });

  it("每个阶段都给出一句关系描述", () => {
    expect(computeRelationship({ daysKnown: 30, consecutiveActiveDays: 3, totalMessageCount: 120 }).description).not.toBe("");
  });
});

describe("deriveRelationshipSignals", () => {
  it("空历史返回全零", () => {
    expect(deriveRelationshipSignals([])).toEqual(EMPTY_RELATIONSHIP_SIGNALS);
  });

  it("按日历天统计相识天数与连续互动天数", () => {
    const now = noonDaysAgo(0);
    const signals = deriveRelationshipSignals(
      [noonDaysAgo(10), noonDaysAgo(2), noonDaysAgo(1), noonDaysAgo(1), noonDaysAgo(0)],
      now,
    );
    expect(signals.daysKnown).toBe(10);
    expect(signals.consecutiveActiveDays).toBe(3);
    expect(signals.totalMessageCount).toBe(5);
  });

  it("中断过的历史只计最近一段连续天数", () => {
    const now = noonDaysAgo(0);
    const signals = deriveRelationshipSignals([noonDaysAgo(9), noonDaysAgo(8), noonDaysAgo(7), noonDaysAgo(0)], now);
    expect(signals.consecutiveActiveDays).toBe(1);
  });

  it("长时间不聊天不会减少相识天数", () => {
    const now = noonDaysAgo(0);
    const idle = deriveRelationshipSignals([noonDaysAgo(60), noonDaysAgo(59)], now);
    expect(idle.daysKnown).toBe(60);
  });
});
