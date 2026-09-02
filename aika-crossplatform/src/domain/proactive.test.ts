import { describe, expect, it } from "vitest";
import type { ConversationTurn } from "./companion";
import {
  canSend, chooseProactiveReason, isQuietHour, MAX_DAILY_MESSAGES,
  type ProactiveReasonInput,
} from "./proactive";

const baseInput = {
  nowMillis: 10_000_000,
  hour: 12,
  quietStartHour: 23,
  quietEndHour: 8,
  messagesToday: 2,
  lastMessageAt: 1_000_000 as number | null,
};

describe("频率闸门", () => {
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

function reasonInput(overrides: Partial<ProactiveReasonInput> = {}): ProactiveReasonInput {
  return {
    recentTurns: [],
    memories: [],
    now: new Date(2026, 8, 2, 15, 0, 0),
    hoursSinceLastUserMessage: 2,
    lastReasonKind: null,
    ...overrides,
  };
}

const turns = (...items: [ConversationTurn["role"], string][]): ConversationTurn[] =>
  items.map(([role, text]) => ({ role, text }));

describe("触发理由", () => {
  it("没有任何线索时退回一个小念头", () => {
    expect(chooseProactiveReason(reasonInput()).kind).toBe("small-thought");
  });

  it("对话停在她那一句时算未聊完的话题", () => {
    const reason = chooseProactiveReason(reasonInput({
      recentTurns: turns(["user", "今天面试完了"], ["companion", "そっか、お疲れさま。"]),
    }));
    expect(reason.kind).toBe("unfinished-topic");
    expect(reason.hint).toContain("今天面试完了");
  });

  it("识别用户提过的计划", () => {
    const reason = chooseProactiveReason(reasonInput({
      recentTurns: turns(["user", "下周要去面试，有点紧张"]),
      lastReasonKind: "unfinished-topic",
    }));
    expect(reason.kind).toBe("user-plan");
  });

  it("周五晚上会作为时间语义触发", () => {
    const reason = chooseProactiveReason(reasonInput({
      now: new Date(2026, 8, 4, 21, 0, 0),
      lastReasonKind: "small-thought",
    }));
    expect(reason.kind).toBe("time-semantics");
    expect(reason.hint).toContain("周五晚上");
  });

  it("记忆里的日期可以成为理由", () => {
    const reason = chooseProactiveReason(reasonInput({
      memories: ["人际：朋友的生日是 10 月 3 日"],
      lastReasonKind: null,
    }));
    expect(reason.kind).toBe("memory-date");
  });

  it("避免连着两次用同一个角度", () => {
    const input = reasonInput({
      recentTurns: turns(["user", "今天面试完了"], ["companion", "そっか。"]),
      lastReasonKind: "unfinished-topic",
    });
    expect(chooseProactiveReason(input).kind).not.toBe("unfinished-topic");
  });

  it("久别触发时明确禁止提起间隔本身", () => {
    const reason = chooseProactiveReason(reasonInput({ hoursSinceLastUserMessage: 200 }));
    expect(reason.kind).toBe("time-semantics");
    expect(reason.hint).toContain("不要提起这段间隔");
  });

  it("任何理由都带着反索取、反负罪感的约束", () => {
    for (const lastReasonKind of [null, "small-thought", "time-semantics"] as const) {
      const reason = chooseProactiveReason(reasonInput({
        lastReasonKind,
        memories: ["人际：朋友的生日是 10 月 3 日"],
      }));
      expect(reason.hint).toContain("不要索取回复，也不要制造负罪感。");
    }
  });
});
