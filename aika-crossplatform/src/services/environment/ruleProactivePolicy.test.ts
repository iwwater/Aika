import { describe, expect, it } from "vitest";
import { ENVIRONMENT_SCHEMA_VERSION, type EnvironmentEvent } from "../../domain/environment";
import { createRuleProactivePolicy, GAME_EVENT_CONFIDENCE_THRESHOLD, WEAK_OCCURRENCES_IN_WINDOW, WEAK_SUSTAINED_MS } from "./ruleProactivePolicy";
import type { ProactivePolicyInput } from "./contracts";

/**
 * FE-22 生产 policy：纯度、阈值冻结值、busy 矩阵。
 */

function input(overrides: Partial<Omit<ProactivePolicyInput, "event">> & {
  payload: ProactivePolicyInput["event"]["payload"];
  confidence?: number;
}): ProactivePolicyInput {
  const event: EnvironmentEvent = {
    schemaVersion: ENVIRONMENT_SCHEMA_VERSION,
    sourceId: "screen",
    eventId: "evt-1",
    hostEpoch: "e",
    timestamp: 0,
    receivedMonotonicMs: 0,
    timingPrecision: "measured",
    confidence: overrides.confidence ?? 1,
    payload: overrides.payload,
  };
  return {
    event,
    now: 0,
    lastSentAt: null,
    proactiveToday: null,
    userBusy: false,
    sustainedMs: 0,
    occurrencesInWindow: 0,
    ...overrides,
  };
}

describe("ruleProactivePolicy（FE-22）", () => {
  const policy = createRuleProactivePolicy();

  it("game_event 结算：confidence ≥0.8 触发；<0.8 拒绝", () => {
    const pass = policy.evaluate(input({ payload: { kind: "game_event", event: "victory" }, confidence: 0.8 }));
    expect(pass.action).toBe("trigger");
    const fail = policy.evaluate(input({ payload: { kind: "game_event", event: "victory" }, confidence: GAME_EVENT_CONFIDENCE_THRESHOLD - 0.01 }));
    expect(fail).toMatchObject({ action: "ignore", reason: "confidence-below-threshold" });
  });

  it("busy=true：结算类候选放行，弱信号一律 ignore；未知不发送", () => {
    const settle = policy.evaluate(input({ payload: { kind: "game_event", event: "defeat" }, userBusy: true, confidence: 0.9 }));
    expect(settle.action).toBe("trigger");

    const keyword = policy.evaluate(input({ payload: { kind: "screen_keyword", keyword: "error" }, userBusy: true }));
    expect(keyword).toMatchObject({ action: "ignore", reason: "busy-true-non-settle" });

    const foreground = policy.evaluate(input({ payload: { kind: "foreground_changed", process: "Code.exe" }, userBusy: true }));
    expect(foreground).toMatchObject({ action: "ignore", reason: "busy-true-non-settle" });

    const unknown = policy.evaluate(input({ payload: { kind: "game_event", event: "victory" }, userBusy: null }));
    expect(unknown).toMatchObject({ action: "ignore", reason: "busy-unknown" });
  });

  it("弱信号：sustainedMs ≥30000 且窗口内 ≥2 次才触发；未达门槛先 remember", () => {
    const weak: Partial<Omit<ProactivePolicyInput, "event">> = { sustainedMs: WEAK_SUSTAINED_MS, occurrencesInWindow: WEAK_OCCURRENCES_IN_WINDOW };
    expect(policy.evaluate(input({ ...weak, payload: { kind: "screen_keyword", keyword: "error" } })).action).toBe("trigger");

    const below = policy.evaluate(input({ payload: { kind: "screen_keyword", keyword: "error" }, sustainedMs: WEAK_SUSTAINED_MS - 1, occurrencesInWindow: 2 }));
    expect(below).toMatchObject({ action: "remember", reason: "weak-signal-below-threshold" });

    const once = policy.evaluate(input({ payload: { kind: "foreground_changed", process: "A" }, sustainedMs: 60_000, occurrencesInWindow: 1 }));
    expect(once).toMatchObject({ action: "remember" });
  });

  it("notification/idle_changed 不可动作；纯函数同输入同输出", () => {
    expect(policy.evaluate(input({ payload: { kind: "notification", app: "Mail" } })).action).toBe("ignore");
    expect(policy.evaluate(input({ payload: { kind: "idle_changed", idleSeconds: 300 } })).action).toBe("ignore");

    const frozen = input({ payload: { kind: "game_event", event: "pentakill" }, confidence: 0.9 });
    expect(policy.evaluate(frozen)).toEqual(policy.evaluate(frozen));
  });
});
