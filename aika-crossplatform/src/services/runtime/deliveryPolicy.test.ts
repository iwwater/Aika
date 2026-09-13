import { describe, expect, it } from "vitest";
import { createDeliveryPolicy, type PersistentDeliveryState } from "./deliveryPolicy";

const BASE = Date.UTC(2026, 0, 10, 12, 0); // 12:00 UTC

function candidate(overrides: Partial<Parameters<ReturnType<typeof createDeliveryPolicy>["evaluate"]>[0]> = {}) {
  return {
    conversationId: "conv-A",
    principalId: "ext-A",
    isGroup: false,
    eventType: "task.completed",
    urgency: "normal" as const,
    targetAuthorized: true,
    ...overrides,
  };
}

describe("跨渠道主动投递策略（RT-06）", () => {
  it("群组永不接私人提醒（RT-06 边界）", () => {
    const policy = createDeliveryPolicy({ defaultChannel: "telegram", cooldownMs: 60_000 });
    const verdict = policy.evaluate(candidate({ isGroup: true }), BASE);
    expect(verdict).toEqual({ action: "drop", reason: "group-private-reminder" });
  });

  it("未授权目标 drop，不自动扩大收件人（RT-06-C）", () => {
    const policy = createDeliveryPolicy({ defaultChannel: "telegram", cooldownMs: 60_000 });
    const verdict = policy.evaluate(candidate({ targetAuthorized: false }), BASE);
    expect(verdict).toEqual({ action: "drop", reason: "unauthorized-target" });
  });

  it("冷却：同 主体+事件类型+目标 在窗口内 defer；持久状态重启不清零（RT-06-A）", () => {
    const state: PersistentDeliveryState = { cooldowns: {}, outboxEvents: {} };
    const policy = createDeliveryPolicy({ defaultChannel: "telegram", cooldownMs: 60_000 }, state);
    policy.markDelivered(candidate(), BASE);

    // 窗口内 defer。
    const within = policy.evaluate(candidate(), BASE + 30_000);
    expect(within.action).toBe("defer");

    // 冷却 key 持久化在 state 里：重启（新实例同 state）不清零。
    const reborn = createDeliveryPolicy({ defaultChannel: "telegram", cooldownMs: 60_000 }, state);
    expect(reborn.evaluate(candidate(), BASE + 59_000).action).toBe("defer");
    // 窗口过后放行。
    expect(reborn.evaluate(candidate(), BASE + 61_000).action).toBe("deliver");
  });

  it("静默时段 defer 到结束；审批请求不按 urgency 绕过（RT-06-A）", () => {
    const quiet = { startHour: 22, endHour: 7, timeZone: "UTC" };
    const policy = createDeliveryPolicy({ defaultChannel: "telegram", cooldownMs: 1000, quietHours: quiet });
    // 23:00 UTC 在静默内：important 也 defer（不绕过）。
    const night = Date.UTC(2026, 0, 10, 23, 0);
    const verdict = policy.evaluate(candidate({ urgency: "important" }), night);
    expect(verdict.action).toBe("defer");
    expect(verdict.reason).toBe("quiet-hours");
  });

  it("同一完成事件多次到达只允许一项 outbox（RT-06-B）", () => {
    const state: PersistentDeliveryState = { cooldowns: {}, outboxEvents: {} };
    const policy = createDeliveryPolicy({ defaultChannel: "telegram", cooldownMs: 0 }, state);
    expect(policy.registerOutboxItem("task.completed:conv-A", BASE)).toBe(true);
    expect(policy.registerOutboxItem("task.completed:conv-A", BASE + 1)).toBe(false);
  });
});
