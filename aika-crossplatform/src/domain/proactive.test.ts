import { describe, expect, it } from "vitest";
import { canSend, isQuietHour, MAX_DAILY_MESSAGES } from "./proactive";

const baseInput = {
  nowMillis: 10_000_000,
  hour: 12,
  quietStartHour: 23,
  quietEndHour: 8,
  messagesToday: 2,
  lastMessageAt: 1_000_000 as number | null,
};

describe("ProactivePolicy", () => {
  it("跨夜免打扰时段包含深夜和清晨", () => {
    expect(isQuietHour(23, 23, 8)).toBe(true);
    expect(isQuietHour(7, 23, 8)).toBe(true);
    expect(isQuietHour(12, 23, 8)).toBe(false);
  });

  it("同日免打扰时段按左闭右开判定", () => {
    expect(isQuietHour(9, 9, 18)).toBe(true);
    expect(isQuietHour(18, 9, 18)).toBe(false);
  });

  it("达到每日上限后不再发送", () => {
    expect(canSend({ ...baseInput, messagesToday: MAX_DAILY_MESSAGES, lastMessageAt: null })).toBe(false);
  });

  it("免打扰时段外且已过冷却时允许发送", () => {
    expect(canSend(baseInput)).toBe(true);
  });

  it("最小间隔内不重复发送", () => {
    expect(canSend({ ...baseInput, lastMessageAt: baseInput.nowMillis - 60 * 60 * 1000 })).toBe(false);
  });

  it("用户关闭后任何条件都不发送", () => {
    expect(canSend({ ...baseInput, enabled: false })).toBe(false);
  });
});
