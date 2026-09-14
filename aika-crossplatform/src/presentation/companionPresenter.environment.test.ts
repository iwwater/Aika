import { describe, expect, it } from "vitest";
import type { RuntimeEvent, TurnSettlement } from "../services/runtime/companionRuntime";
import type { CompanionRuntime } from "../services/runtime/companionRuntime";
import type { ReplyEnvelopeV1 } from "../domain/companion";
import { PROVIDER_PRESETS } from "../domain/providers";
import { createProviderSettings } from "../services/runtime/providerSettings";
import { createManualClock, createFakeEnvironmentSource, fakeEventInput } from "../services/environment/fakeEnvironment";
import { createEnvironmentMonitor } from "../services/environment/monitor";
import { createRuleProactivePolicy } from "../services/environment/ruleProactivePolicy";
import { FOREGROUND_SOURCE_ID } from "../services/environment/foregroundSource";
import type { BusyObserver } from "../services/environment/busySource";
import type { AikaStorage } from "../services/storage/contracts";
import { SETTING_KEYS } from "../services/storage/contracts";
import { createInsecureSecretStore, installSecretStore, providerKeyName } from "../services/storage/secretStore";
import { createCompanionPresenter, type CompanionPresenter } from "./companionPresenter";

/**
 * FE-22 presenter 集成：
 * - A：环境触发走既有主动发送路径（source=proactive、写 proactiveLast 键）。
 * - H：共享发送预约——同刻双 event 至多一次提交。
 * - I：submit 失败释放预约（不永久 busy）；submit 成功但持久化失败 → 不重发、
 *   阻止后续；对账成功后恢复正常。
 */

function createFakeRuntime() {
  const listeners = new Set<(event: RuntimeEvent) => void>();
  const requests: Array<{ text: string; source: string }> = [];
  const submitted: string[] = [];
  let counter = 0;
  let seq = 0;
  let failSubmits = false;

  const emit = (turnId: string, event: Record<string, unknown>) => {
    seq += 1;
    const full = { turnId, seq, ...event } as RuntimeEvent;
    for (const listener of [...listeners]) listener(full);
  };

  const runtime: CompanionRuntime = {
    submit(request) {
      counter += 1;
      const turnId = `turn-${counter}`;
      submitted.push(turnId);
      requests.push({ text: request.text, source: request.source });
      let resolveDone!: (settlement: TurnSettlement) => void;
      const done = new Promise<TurnSettlement>((resolve) => { resolveDone = resolve; });
      if (failSubmits) {
        emit(turnId, { type: "error", code: "PROVIDER_DOWN", retryable: true, message: "provider down" });
        emit(turnId, { type: "settled", state: "failed", persisted: false });
        resolveDone({ state: "failed", persisted: false });
        return { turnId, done };
      }
      const reply: ReplyEnvelopeV1 = { schemaVersion: 1, mood: "neutral", replyText: "環境の返事", translation: "", memoryCandidates: [], actions: [] };
      setTimeout(() => {
        emit(turnId, { type: "generated", reply });
        emit(turnId, { type: "settled", state: "completed", persisted: true });
        resolveDone({ state: "completed", persisted: true });
      }, 6);
      return { turnId, done };
    },
    cancel() {},
    reportDelivery() {},
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    dispose() { listeners.clear(); },
  };

  return {
    runtime,
    submitted,
    requests,
    setFailSubmits(value: boolean) { failSubmits = value; },
  };
}

function createSettingsStorage(options: { failSettingWrites?: () => boolean } = {}) {
  const values = new Map<string, string>();
  const storage = {
    kind: "local" as const,
    getSetting: async (key: string) => values.get(key) ?? null,
    setSetting: async (key: string, value: string) => {
      if (options.failSettingWrites?.()) throw new Error("storage write failed");
      values.set(key, value);
    },
    values,
    listMessages: async () => [],
    appendMessage: async () => undefined,
    listMessageTimestamps: async () => [],
    countMessagesSince: async () => 0,
    countProactiveSince: async () => 0,
    deleteMessages: async () => undefined,
    clearMessages: async () => undefined,
    listMemories: async () => [],
    addMemories: async () => undefined,
    setMemoryStatus: async () => undefined,
    deleteMemory: async () => undefined,
    summaries: [] as unknown[],
    latestSummary: async () => null,
    saveSummary: async () => undefined,
    deleteSummaries: async () => undefined,
  };
  return storage as never as AikaStorage & { values: Map<string, string> };
}

function busyAlways(value: boolean | null): BusyObserver {
  return {
    refresh: async () => ({ value, observedMonotonicMs: 0, hostEpoch: "e", reasonCode: value === null ? "unknown" : "normal_window" }),
    current: () => ({ value, observedMonotonicMs: Number.MAX_SAFE_INTEGER, hostEpoch: "e", reasonCode: value === null ? "unknown" : "normal_window" }),
    clear: () => undefined,
  };
}

/** 静音窗口取「当前小时 +1 ~ +2」：确定性避开现在时刻。 */
function quietWindowExcludingNow(): { quietStartHour: number; quietEndHour: number } {
  const hour = new Date().getHours();
  return { quietStartHour: (hour + 1) % 24, quietEndHour: (hour + 2) % 24 };
}

async function setup(options: { failSettingWrites?: () => boolean; failSubmits?: boolean } = {}) {
  const clock = createManualClock(0);
  const storage = createSettingsStorage(options);
  const fake = createFakeRuntime();
  fake.setFailSubmits(options.failSubmits ?? false);
  const quiet = quietWindowExcludingNow();
  storage.values.set(SETTING_KEYS.proactive, JSON.stringify({ enabled: true, ...quiet }));
  storage.values.set(SETTING_KEYS.environmentProactiveEnabled, "true");
  storage.values.set(SETTING_KEYS.environmentContextEnabled, "true");
  // connected() 需要 apiKey：密钥走全局 secretStore（测试装内存实现，不碰 localStorage）。
  const secretValues = new Map<string, string>();
  const secretStoreInstance = createInsecureSecretStore({
    get: (key: string) => secretValues.get(key) ?? null,
    set: (key: string, value: string) => void secretValues.set(key, value),
  });
  await secretStoreInstance.set(providerKeyName(PROVIDER_PRESETS[1].id), "test-key");
  installSecretStore(secretStoreInstance);

  const fg = createFakeEnvironmentSource({ id: FOREGROUND_SOURCE_ID, deferred: false });
  const monitor = createEnvironmentMonitor([fg], { clock, hostEpoch: "test-epoch" });

  const presenter: CompanionPresenter = createCompanionPresenter({
    loadStorage: async () => storage,
    notifier: { notify: async () => false },
    loadStickers: async () => [],
    runtime: { runtime: fake.runtime, settings: createProviderSettings(PROVIDER_PRESETS[1]) },
    environment: {
      monitor,
      policy: createRuleProactivePolicy(),
      busyObserver: busyAlways(false),
      clock,
    },
  });
  await presenter.start();
  await monitor.setSourceEnabled(FOREGROUND_SOURCE_ID, true);
  let emitted = 0;
  const emitVictory = () => {
    emitted += 1;
    fg.emit(fakeEventInput({
      payload: { kind: "game_event", event: "victory" },
      sourceId: FOREGROUND_SOURCE_ID,
      confidence: 0.9,
      eventId: `evt-${emitted}-${Math.random().toString(16).slice(2)}`,
    }));
  };
  return { presenter, storage, fake, monitor, clock, emitVictory };
}

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("companionPresenter 环境主动集成（FE-22）", () => {
  it("A：game_event 触发 → source=proactive、请求含受控提示、写 proactiveLast 键", async () => {
    const { fake, storage, emitVictory } = await setup();
    emitVictory();
    await settle(40);

    expect(fake.submitted).toHaveLength(1);
    expect(fake.requests[0].source).toBe("proactive");
    expect(fake.requests[0].text).toContain("victory");
    expect(storage.values.get(SETTING_KEYS.proactiveLastReason)).toBe("game-result");
    expect(storage.values.get(SETTING_KEYS.proactiveLastSentAt)).toBeTruthy();
  });

  it("H：同刻双 event 至多一次提交（共享发送预约）", async () => {
    const { fake, emitVictory } = await setup();
    emitVictory();
    emitVictory();
    await settle(40);
    expect(fake.submitted).toHaveLength(1);
  });

  it("I：submit 失败释放预约（后续可再次提交，不永久 busy）", async () => {
    const { fake, clock, emitVictory } = await setup({ failSubmits: true });
    emitVictory();
    await settle(30);
    expect(fake.submitted).toHaveLength(1);

    clock.advance(2100); // 跳出 monitor 去重窗口：第二次是合法的新事件。
    fake.setFailSubmits(false);
    emitVictory();
    await settle(30);
    expect(fake.submitted).toHaveLength(2);
    expect(fake.requests[1].source).toBe("proactive");
  });

  it("I：submit 成功但持久化失败 → 不重发且阻止后续；对账成功后恢复", async () => {
    let failWrites = true;
    const { fake, storage, clock, emitVictory } = await setup({ failSettingWrites: () => failWrites });

    emitVictory();
    await settle(40);
    expect(fake.submitted).toHaveLength(1);
    expect(storage.values.has(SETTING_KEYS.proactiveLastSentAt)).toBe(false);

    // 持久化仍失败：第二次触发被阻止（不确定状态不继续主动发送）。
    clock.advance(2100);
    emitVictory();
    await settle(40);
    expect(fake.submitted).toHaveLength(1);

    // 对账：写恢复后，下一次触发完成重写并正常发送（幂等，不重复提交历史轮）。
    failWrites = false;
    clock.advance(2100);
    emitVictory();
    await settle(40);
    expect(fake.submitted).toHaveLength(2);
    expect(storage.values.get(SETTING_KEYS.proactiveLastSentAt)).toBeTruthy();
  });
});

describe("sendEnvironmentProactive（FE-31 接线）", () => {
  it("走同一份共享预约与同一套门禁；理由里不出现任何屏幕文字", async () => {
    const { presenter, fake, storage } = await setup();

    expect(await presenter.sendEnvironmentProactive(["screen-text"])).toBe(true);
    await settle(20);
    expect(fake.submitted).toHaveLength(1);
    expect(fake.requests[0].source).toBe("proactive");
    // 传进去的只是一个受控标识；摘录由 FE-32 的上下文源另行裁决，不从理由进模型。
    expect(fake.requests[0].text).not.toContain("screen-text");
    expect(storage.values.get(SETTING_KEYS.proactiveLastReason)).toBe("environment-weak");
  });

  it("与环境事件同刻竞争时至多一次提交（预约非排队）", async () => {
    const { presenter, fake, emitVictory } = await setup();
    emitVictory();
    const second = presenter.sendEnvironmentProactive(["screen-text"]);
    await settle(40);
    await second;
    expect(fake.submitted).toHaveLength(1);
  });
});
