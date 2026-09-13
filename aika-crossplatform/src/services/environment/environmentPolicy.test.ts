import { describe, expect, it } from "vitest";
import { ENVIRONMENT_SCHEMA_VERSION, normalizeEnvironmentEvent, type EnvironmentEvent } from "../../domain/environment";
import { createIgnoreAllPolicy, fakeEventInput } from "./fakeEnvironment";
import type { ProactivePolicyInput } from "./contracts";

/**
 * 默认 policy 的纯度与语义（FE-18-E）。
 *
 * 生产 ruleProactivePolicy（FE-22）将来也跑这一组；policy 是纯函数，
 * conformance 只需要确定性输入。
 */

function policyInput(overrides: Partial<ProactivePolicyInput> & { payload: ProactivePolicyInput["event"]["payload"] }): ProactivePolicyInput {
  const event: EnvironmentEvent = {
    schemaVersion: ENVIRONMENT_SCHEMA_VERSION,
    sourceId: "fg",
    eventId: "evt-1",
    hostEpoch: "test-epoch",
    timestamp: 1000,
    receivedMonotonicMs: 0,
    timingPrecision: "measured",
    confidence: 1,
    payload: overrides.payload,
  };
  return {
    event,
    now: 0,
    lastSentAt: null,
    proactiveToday: null,
    userBusy: null,
    sustainedMs: 0,
    occurrencesInWindow: 0,
    ...overrides,
  };
}

describe("默认 ProactivePolicy（FE-18-E）", () => {
  const policy = createIgnoreAllPolicy();

  it("五种 kind 全部 ignore 且带 reason", () => {
    const kinds = [
      { kind: "foreground_changed" as const, process: "Code.exe" },
      { kind: "screen_keyword" as const, keyword: "Error" },
      { kind: "game_event" as const, event: "victory" },
      { kind: "notification" as const, app: "Mail" },
      { kind: "idle_changed" as const, idleSeconds: 120 },
    ];
    for (const payload of kinds) {
      const decision = policy.evaluate(policyInput({ payload }));
      expect(decision.action).toBe("ignore");
      expect(decision.reason).toContain(payload.kind);
    }
  });

  it("纯函数：同输入同输出，无隐藏状态", () => {
    const input = policyInput({ payload: { kind: "game_event", event: "victory" }, userBusy: false, sustainedMs: 60_000, occurrencesInWindow: 3 });
    const first = policy.evaluate(input);
    const second = policy.evaluate(input);
    expect(first).toEqual(second);
    // 复跑一遍仍是同结果：没有内部计数被前两次调用改变。
    expect(policy.evaluate(input)).toEqual(first);
  });

  it("userBusy 未知（null）时不得触发", () => {
    const decision = policy.evaluate(policyInput({ payload: { kind: "game_event", event: "victory" }, userBusy: null }));
    expect(decision.action).toBe("ignore");
  });
});

describe("normalizeEnvironmentEvent 补充（conformance 之外的边界）", () => {
  it("payload 缺失与非对象被拒绝", () => {
    const base = fakeEventInput({ payload: { kind: "game_event", event: "victory" }, sourceId: "fg" });
    expect(normalizeEnvironmentEvent({ ...base, payload: null as never }, { sourceId: "fg", receivedMonotonicMs: 0 }).ok).toBe(false);
    expect(normalizeEnvironmentEvent({ ...base, payload: "victory" as never }, { sourceId: "fg", receivedMonotonicMs: 0 }).ok).toBe(false);
  });

  it("timingPrecision 非法被拒绝", () => {
    const base = fakeEventInput({ payload: { kind: "game_event", event: "victory" }, sourceId: "fg" });
    const result = normalizeEnvironmentEvent({ ...base, timingPrecision: "precise" as never }, { sourceId: "fg", receivedMonotonicMs: 0 });
    expect(result.ok).toBe(false);
  });

  it("通过的事件带上 monitor 打点的 receivedMonotonicMs", () => {
    const base = fakeEventInput({ payload: { kind: "foreground_changed", process: "A" }, sourceId: "fg" });
    const result = normalizeEnvironmentEvent(base, { sourceId: "fg", receivedMonotonicMs: 42 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.event.receivedMonotonicMs).toBe(42);
  });
});
