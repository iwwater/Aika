import { describe, expect, it } from "vitest";
import { createManualClock } from "../services/environment/fakeEnvironment";
import { createRuleProactivePolicy } from "../services/environment/ruleProactivePolicy";
import {
  ENVIRONMENT_SUMMARY_TTL_MS,
  createEnvironmentTrigger,
} from "./environmentTrigger";
import { ENVIRONMENT_SCHEMA_VERSION, type EnvironmentEvent } from "../domain/environment";
import type { ProactiveReasonKind } from "../domain/proactive";

/**
 * FE-22-G/H/J（触发器层）：三开关矩阵、TTL/busy 边界、缓冲、零原文出口。
 * 发送预约与 presenter 集成在 companionPresenter.environment.test.ts。
 */

function makeEvent(overrides: Partial<EnvironmentEvent> & {
  payload: EnvironmentEvent["payload"];
}): EnvironmentEvent {
  return {
    schemaVersion: ENVIRONMENT_SCHEMA_VERSION,
    sourceId: "screen",
    eventId: `evt-${Math.random().toString(16).slice(2)}`,
    hostEpoch: "e",
    timestamp: 0,
    receivedMonotonicMs: 0,
    timingPrecision: "measured",
    confidence: 0.95,
    ...overrides,
  };
}

function setup(options: {
  busy?: boolean | null;
  busyReason?: string;
  gates?: { global?: boolean; environment?: boolean; context?: boolean };
  running?: boolean;
  recentWithinTtlMs?: number;
  /** monitor 的 recent 摘要里那条规则 ID；要与被测事件一致，否则过不了 TTL 门禁。 */
  recentRuleId?: string;
} = {}) {
  const clock = createManualClock(0);
  const submits: Array<{ reasonKind: ProactiveReasonKind; buffer: readonly string[] }> = [];
  let busyValue: boolean | null = options.busy ?? null;
  let busyReason = options.busyReason ?? (options.busy === null ? "unknown" : "normal_window");
  const gates = {
    globalProactive: async () => options.gates?.global ?? true,
    environmentProactive: async () => options.gates?.environment ?? true,
    contextEnabled: async () => options.gates?.context ?? true,
    canSend: async () => true,
  };
  // 最小 monitor 桩：statuses/recent 由测试参数驱动（触发器层不需要完整 monitor）。
  const monitor = {
    snapshot: { foreground: null },
    subscribe: () => () => undefined,
    onStateChange: () => () => undefined,
    statuses: () => [{ sourceId: "screen", state: options.running === false ? "off" : "running", generation: 1, error: null }],
    recent: () => {
      const age = options.recentWithinTtlMs ?? ENVIRONMENT_SUMMARY_TTL_MS - 1;
      return [{ sourceId: "screen", kind: "game_event", ruleId: options.recentRuleId ?? "victory", process: null, confidence: 0.95, receivedMonotonicMs: clock.now() - age }];
    },
    setSourceEnabled: async () => undefined,
    stopAll: async () => undefined,
    diagnostics: () => ({}) as never,
    dispose: async () => undefined,
  };
  const busy = options.busy === undefined ? null : {
    refresh: async () => ({ value: busyValue, observedMonotonicMs: clock.now(), hostEpoch: "e", reasonCode: busyReason }),
    current: () => ({ value: busyValue, observedMonotonicMs: clock.now(), hostEpoch: "e", reasonCode: busyReason }),
    clear: () => undefined,
  };
  const trigger = createEnvironmentTrigger({
    monitor: monitor as never,
    policy: createRuleProactivePolicy(),
    busy: busy as never,
    clock,
    gates,
    attemptSend: async (_event, reasonKind, buffer) => {
      submits.push({ reasonKind, buffer });
      return true;
    },
  });
  trigger.start();
  return {
    trigger, clock, submits,
    /** 运行中切换忙碌观测（锁屏/解锁/全屏），用来验证门禁读的是当下观测而不是旧值。 */
    setBusy(value: boolean | null, reason = "normal_window") {
      busyValue = value;
      busyReason = reason;
    },
  };
}

describe("environmentTrigger（FE-22-G）", () => {
  it("三开关矩阵：任一关闭 → 零 submit，原因计数可见", async () => {
    for (const gates of [
      { global: false, environment: true, context: true },
      { global: true, environment: false, context: true },
      { global: true, environment: true, context: false },
    ]) {
      const { trigger, submits } = setup({ gates, busy: false });
      await trigger.handleEvent(makeEvent({ payload: { kind: "game_event", event: "victory" } }));
      expect(submits).toHaveLength(0);
      expect(trigger.snapshot().gateRejectedCount).toBe(1);
    }
  });

  it("busy unknown / 过期观测 → 零 submit 且单独计数（PRO-04）", async () => {
    const unknown = setup({ busy: null });
    await unknown.trigger.handleEvent(makeEvent({ payload: { kind: "game_event", event: "victory" } }));
    expect(unknown.submits).toHaveLength(0);
    expect(unknown.trigger.snapshot().busyUnknownCount).toBe(1);
  });

  it("TTL 边界：事件摘要 59999ms 仍可触发，60000ms 过期拒绝", async () => {
    const fresh = setup({ busy: false, recentWithinTtlMs: ENVIRONMENT_SUMMARY_TTL_MS - 1 });
    await fresh.trigger.handleEvent(makeEvent({ payload: { kind: "game_event", event: "victory" } }));
    expect(fresh.submits).toHaveLength(1);

    const stale = setup({ busy: false, recentWithinTtlMs: ENVIRONMENT_SUMMARY_TTL_MS });
    await stale.trigger.handleEvent(makeEvent({ payload: { kind: "game_event", event: "victory" } }));
    expect(stale.submits).toHaveLength(0);
    expect(stale.trigger.snapshot().gateRejectedCount).toBe(1);
  });

  it("source 未运行 → 拒绝（generation/状态门禁）", async () => {
    const stopped = setup({ busy: false, running: false });
    await stopped.trigger.handleEvent(makeEvent({ payload: { kind: "game_event", event: "victory" } }));
    expect(stopped.submits).toHaveLength(0);
  });

  it("弱信号经缓冲累计到门槛后触发：attemptSend 只收到词表 ID 摘要", async () => {
    const clock = createManualClock(0);
    const submits: Array<{ reasonKind: ProactiveReasonKind; buffer: readonly string[] }> = [];
    const monitor = {
      snapshot: { foreground: null },
      subscribe: () => () => undefined,
      onStateChange: () => () => undefined,
      statuses: () => [{ sourceId: "screen", state: "running", generation: 1, error: null }],
      recent: () => [{ sourceId: "screen", kind: "screen_keyword", ruleId: "error", process: null, confidence: 0.9, receivedMonotonicMs: clock.now() }],
      setSourceEnabled: async () => undefined,
      stopAll: async () => undefined,
      diagnostics: () => ({}) as never,
      dispose: async () => undefined,
    };
    const trigger = createEnvironmentTrigger({
      monitor: monitor as never,
      policy: createRuleProactivePolicy(),
      busy: { refresh: async () => ({ value: false, observedMonotonicMs: clock.now(), hostEpoch: "e", reasonCode: "normal_window" }), current: () => ({ value: false, observedMonotonicMs: clock.now(), hostEpoch: "e", reasonCode: "normal_window" }), clear: () => undefined } as never,
      clock,
      gates: {
        globalProactive: async () => true,
        environmentProactive: async () => true,
        contextEnabled: async () => true,
        canSend: async () => true,
      },
      attemptSend: async (_event, reasonKind, buffer) => {
        submits.push({ reasonKind, buffer });
        return true;
      },
    });
    trigger.start();

    const base = { sourceId: "screen", timestamp: 0, receivedMonotonicMs: 0 };
    // 第一次：remember。
    await trigger.handleEvent(makeEvent({ ...base, payload: { kind: "screen_keyword", keyword: "error" }, eventId: "e1" }));
    expect(submits).toHaveLength(0);
    expect(trigger.snapshot().bufferCount).toBe(1);
    clock.advance(2000);
    // 第二次（窗口内第 2 次，sustained 2000ms <30s）：仍 remember。
    await trigger.handleEvent(makeEvent({ ...base, payload: { kind: "screen_keyword", keyword: "error" }, eventId: "e2" }));
    expect(submits).toHaveLength(0);
    clock.advance(28_000);
    // 第三次：窗口内 3 次、最早距今 30s → trigger。
    await trigger.handleEvent(makeEvent({ ...base, payload: { kind: "screen_keyword", keyword: "error" }, eventId: "e3" }));
    expect(submits).toHaveLength(1);
    expect(submits[0].reasonKind).toBe("environment-weak");
    // 摘要是词表 ID 计数（三次 error），无任何原文。
    expect(submits[0].buffer).toEqual(["error", "error", "error"]);
  });

  it("缓冲上限 20、过期剔除；清理入口清空", async () => {
    const { trigger, clock } = setup({ busy: false });
    for (let index = 0; index < 25; index += 1) {
      clock.advance(1000);
      await trigger.handleEvent(makeEvent({ payload: { kind: "game_event", event: "victory" }, eventId: `evt-${index}` }));
    }
    // 25 次事件全部落在 60s 窗口内：触发型也进缓冲，上限 20。
    expect(trigger.snapshot().bufferCount).toBe(20);
    // TTL 过期剔除：推进 61s 后新事件把旧条全部清掉，只剩当前一条。
    clock.advance(61_000);
    await trigger.handleEvent(makeEvent({ payload: { kind: "game_event", event: "victory" }, eventId: "evt-late" }));
    expect(trigger.snapshot().bufferCount).toBe(1);
    trigger.clearBuffer();
    expect(trigger.buffer()).toEqual([]);
  });

  it("FE-22-J：恶意事件进入生产链路 —— reason 只含词表 ID，无原文出口", async () => {
    const { trigger, submits } = setup({ busy: false });
    await trigger.handleEvent(makeEvent({
      payload: { kind: "game_event", event: "victory" },
      eventId: "evt-malicious",
    }));
    expect(submits).toHaveLength(1);
    const serialized = JSON.stringify(submits);
    expect(serialized).toContain("victory");
    expect(serialized).not.toContain("INJECTED");
    expect(serialized).not.toContain("IGNORE-PREVIOUS");
  });

  it("锁屏（session_locked）→ 零 submit 且清空缓冲，解锁后不补发（MVP-04 AC-B）", async () => {
    const h = setup({ busy: false });
    // 1. 先攒一条弱信号：未到门槛 → remember（正常情况下留着等累计）。
    await h.trigger.handleEvent(makeEvent({ payload: { kind: "screen_keyword", keyword: "error" }, eventId: "w1" }));
    expect(h.submits).toHaveLength(0);
    expect(h.trigger.snapshot().bufferCount).toBe(1);

    // 2. 锁屏：连结算类候选（victory）也不发，决策原因可见。
    h.setBusy(true, "session_locked");
    await h.trigger.handleEvent(makeEvent({ payload: { kind: "game_event", event: "victory" }, eventId: "l1" }));
    expect(h.submits).toHaveLength(0);
    expect(h.trigger.snapshot().lastDecision?.reason).toBe("session-locked");
    // 缓冲被清空：锁屏期间累计的「持续时长」不能留给解锁后当依据。
    expect(h.trigger.snapshot().bufferCount).toBe(0);

    // 3. 解锁后同样的弱信号要从头累计，不因为锁屏期间的记忆而立刻触发。
    h.setBusy(false, "normal_window");
    await h.trigger.handleEvent(makeEvent({ payload: { kind: "screen_keyword", keyword: "error" }, eventId: "w2" }));
    expect(h.submits).toHaveLength(0);
    expect(h.trigger.snapshot().bufferCount).toBe(1);
  });

  it("全屏（fullscreen）与锁屏是两回事：结算类候选照常触发（FE-22 冻结语义）", async () => {
    // 这条是刻意的语义边界：全屏=在玩游戏，结算类事件正是陪伴的触发点；
    // 锁屏=用户不在桌面前（上一条）。宿主把两者分开报，代码也必须分开处理。
    const h = setup({ busy: true, busyReason: "fullscreen", recentRuleId: "pentakill" });
    await h.trigger.handleEvent(makeEvent({ payload: { kind: "game_event", event: "pentakill" }, eventId: "p1" }));
    expect(h.submits).toHaveLength(1);
    expect(h.submits[0].reasonKind).toBe("game-result");
  });
});
