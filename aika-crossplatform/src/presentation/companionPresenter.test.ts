import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../domain/conversation";
import type { ReplyEnvelopeV1 } from "../domain/companion";
import { PROVIDER_PRESETS } from "../domain/providers";
import type {
  CompanionRuntime, RuntimeEvent, SubmitRequest, TurnSettlement,
} from "../services/runtime/companionRuntime";
import { createProviderSettings } from "../services/runtime/providerSettings";
import { createCompanionPresenter, type CompanionPresenter } from "./companionPresenter";

/**
 * CORE-04-A/B/D：在没有 React 的 node 环境里，用 fake Runtime 直接驱动 Presenter。
 *
 * 这里验的是 CORE-04 真正想分开的两件事：业务状态归 Presenter，React 只订阅。
 * fake Runtime 让「流式 / 完成 / 失败 / 取消 / 旧轮迟到」五种时序可精确控制，
 * 不必依赖真实 Provider 或网络。
 */

vi.mock("../services/storage", () => ({
  openStorage: async () => { throw new Error("test must inject loadStorage"); },
  loadProvider: async (_storage: unknown, fallback: Record<string, unknown>) => ({ ...fallback, apiKey: "test-key" }),
  saveProvider: vi.fn(async () => undefined),
  secretStore: { secure: async () => false },
  SETTING_KEYS: {
    proactive: "proactive",
    memoryExtraction: "memory.extraction",
    voiceBackend: "voice.backend",
    whisperEndpoint: "voice.whisperEndpoint",
    provider: "provider",
    proactiveLastReason: "proactive.lastReason",
    proactiveLastSentAt: "proactive.lastSentAt",
    mode: "llm.mode",
  },
}));

interface FakeTurn {
  request: SubmitRequest;
  settle: (settlement: TurnSettlement) => void;
}

interface FakeRuntime {
  runtime: CompanionRuntime;
  last(): { turnId: string; request: SubmitRequest };
  delta(turnId: string, cumulative: string): void;
  generated(turnId: string, reply: ReplyEnvelopeV1): void;
  error(turnId: string, code: string, message?: string): void;
  settle(turnId: string, settlement: TurnSettlement): void;
  cancelled: string[];
}

function createFakeRuntime(): FakeRuntime {
  const listeners = new Set<(event: RuntimeEvent) => void>();
  const turns = new Map<string, FakeTurn>();
  const cancelled: string[] = [];
  let counter = 0;
  let seq = 0;

  const emit = (turnId: string, event: Record<string, unknown>) => {
    seq += 1;
    const full = { turnId, seq, ...event } as RuntimeEvent;
    for (const listener of [...listeners]) listener(full);
  };

  const runtime: CompanionRuntime = {
    submit(request) {
      counter += 1;
      const turnId = `turn-${counter}`;
      let resolve!: (settlement: TurnSettlement) => void;
      const done = new Promise<TurnSettlement>((promise) => { resolve = promise; });
      turns.set(turnId, { request, settle: resolve });
      return { turnId, done };
    },
    cancel(turnId) {
      cancelled.push(turnId);
      const turn = turns.get(turnId);
      if (!turn) return;
      emit(turnId, { type: "settled", state: "cancelled", persisted: true });
      turns.delete(turnId);
      turn.settle({ state: "cancelled", persisted: true });
    },
    reportDelivery() {
      // 交付回执由语音链路验证；本文只覆盖文本轮。
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    dispose() { listeners.clear(); },
  };

  return {
    runtime,
    cancelled,
    last() {
      const ids = [...turns.keys()];
      const turnId = ids[ids.length - 1];
      return { turnId, request: turns.get(turnId)!.request };
    },
    delta(turnId, cumulative) { emit(turnId, { type: "replyDelta", text: "", cumulative }); },
    generated(turnId, reply) { emit(turnId, { type: "generated", reply }); },
    error(turnId, code, message) { emit(turnId, { type: "error", code, retryable: true, message }); },
    settle(turnId, settlement) {
      const turn = turns.get(turnId);
      if (!turn) return;
      emit(turnId, { type: "settled", ...settlement });
      turns.delete(turnId);
      turn.settle(settlement);
    },
  };
}

function createStorage() {
  const rows: ChatMessage[] = [];
  return {
    kind: "local" as const,
    rows,
    listMessages: async () => rows.slice(-200),
    appendMessage: async (message: ChatMessage) => {
      const index = rows.findIndex((item) => item.id === message.id);
      if (index >= 0) rows[index] = message;
      else rows.push(message);
    },
    listMessageTimestamps: async () => rows.filter((message) => !message.error).map((message) => message.createdAt),
    countMessagesSince: async () => 0,
    countProactiveSince: async () => 0,
    clearMessages: async () => { rows.length = 0; },
    listMemories: async () => [],
    addMemories: async () => undefined,
    setMemoryStatus: async () => undefined,
    deleteMemory: async () => undefined,
    latestSummary: async () => null,
    saveSummary: async () => undefined,
    getSetting: async () => null,
    setSetting: async () => undefined,
  };
}

function envelope(replyText: string, translation = ""): ReplyEnvelopeV1 {
  return {
    schemaVersion: 1, mood: "neutral", replyText, translation,
    memoryCandidates: [], actions: [],
  };
}

function setup() {
  const storage = createStorage();
  const fake = createFakeRuntime();
  const settings = createProviderSettings(PROVIDER_PRESETS[1]);
  const presenter: CompanionPresenter = createCompanionPresenter({
    loadStorage: async () => storage,
    notifier: { notify: async () => false },
    loadStickers: async () => [],
    extractor: { extract: async () => [], summarize: async () => "" },
    runtime: { runtime: fake.runtime, settings },
  });
  return { presenter, storage, fake };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

describe("CompanionPresenter 无 React 驱动", () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => {
    ctx = setup();
  });

  it("流式→完成：快照随增量增长，结算后用存储里的权威结果对齐", async () => {
    await ctx.presenter.start();
    expect(ctx.presenter.getSnapshot().ready).toBe(true);
    expect(ctx.presenter.getSnapshot().messages).toHaveLength(1);

    const sent = ctx.presenter.send("你好");
    const turn = ctx.fake.last();
    expect(ctx.presenter.getSnapshot().sending).toBe(true);

    ctx.fake.delta(turn.turnId, "こん");
    expect(latestAssistant(ctx.presenter)?.content).toBe("こん");
    ctx.fake.delta(turn.turnId, "こんにちは");
    expect(latestAssistant(ctx.presenter)?.content).toBe("こんにちは");
    expect(latestAssistant(ctx.presenter)?.pending).toBe(true);

    // Runtime 落库是权威：模拟它写入一条带 runtimeTurnId 的完整回复。
    ctx.storage.rows.push({
      id: "assistant-1", role: "assistant", content: "こんにちは",
      japaneseText: "こんにちは", chineseTranslation: "你好", mood: "neutral",
      source: "text", runtimeTurnId: turn.turnId, completion: "complete",
      createdAt: Date.now(), time: "00:00",
    });
    ctx.fake.generated(turn.turnId, envelope("こんにちは", "你好"));
    ctx.fake.settle(turn.turnId, { state: "completed", persisted: true });
    await sent;
    await flush();

    const snapshot = ctx.presenter.getSnapshot();
    expect(snapshot.sending).toBe(false);
    expect(snapshot.messages.some((message) => message.id === "assistant-1")).toBe(true);
    expect(snapshot.messages.some((message) => message.pending)).toBe(false);
    await expect(sent).resolves.toMatchObject({ japaneseText: "こんにちは" });
  });

  it("失败：错误消息可见、发送状态释放、不伪称成功", async () => {
    await ctx.presenter.start();
    const sent = ctx.presenter.send("你好");
    const turn = ctx.fake.last();

    ctx.fake.error(turn.turnId, "PROVIDER_FAILED", "连接被重置");
    ctx.fake.settle(turn.turnId, { state: "failed", persisted: true, errorCode: "PROVIDER_FAILED" });
    await sent;
    await flush();

    const snapshot = ctx.presenter.getSnapshot();
    expect(snapshot.sending).toBe(false);
    expect(snapshot.messages.some((message) => message.error && message.content.includes("连接被重置"))).toBe(true);
  });

  it("取消：交给 Runtime 取消，界面不再认为这一轮仍在进行", async () => {
    await ctx.presenter.start();
    void ctx.presenter.send("你好");
    const turn = ctx.fake.last();

    ctx.presenter.cancel();
    expect(ctx.fake.cancelled).toEqual([turn.turnId]);
    await flush();
    expect(ctx.presenter.getSnapshot().sending).toBe(false);
    expect(ctx.presenter.getSnapshot().activeTurnId).toBeNull();
  });

  it("旧 turn 的迟到增量与终态不覆盖新消息", async () => {
    await ctx.presenter.start();
    void ctx.presenter.send("第一轮");
    const first = ctx.fake.last();

    void ctx.presenter.send("第二轮");
    const second = ctx.fake.last();
    expect(second.turnId).not.toBe(first.turnId);

    ctx.fake.delta(first.turnId, "不许出现的迟到内容");
    ctx.fake.generated(first.turnId, envelope("不许出现的迟到内容"));
    await flush();

    expect(ctx.presenter.getSnapshot().messages.some(
      (message) => message.content.includes("迟到"),
    )).toBe(false);
    expect(latestAssistant(ctx.presenter)?.id).not.toBeUndefined();
    // 清理：让第一轮的 promise 落地，避免悬挂。
    ctx.fake.settle(first.turnId, { state: "cancelled", persisted: false });
    ctx.fake.settle(second.turnId, { state: "cancelled", persisted: false });
    await flush();
  });

  it("CORE-04-B 快照稳定：无变化同一引用，每次增量恰好一次通知", async () => {
    await ctx.presenter.start();
    const stable = ctx.presenter.getSnapshot();
    expect(ctx.presenter.getSnapshot()).toBe(stable);

    let notifications = 0;
    const unsubscribe = ctx.presenter.subscribe(() => { notifications += 1; });

    void ctx.presenter.send("你好");
    const turn = ctx.fake.last();
    const afterSubmit = ctx.presenter.getSnapshot();
    expect(notifications).toBeGreaterThan(0);
    expect(ctx.presenter.getSnapshot()).toBe(afterSubmit);

    const before = notifications;
    ctx.fake.delta(turn.turnId, "一");
    expect(notifications).toBe(before + 1);
    const afterDelta = ctx.presenter.getSnapshot();
    expect(afterDelta).not.toBe(afterSubmit);
    expect(ctx.presenter.getSnapshot()).toBe(afterDelta);

    // 再次读取不产生新快照，也不额外通知。
    expect(ctx.presenter.getSnapshot()).toBe(afterDelta);
    expect(notifications).toBe(before + 1);

    unsubscribe();
    ctx.fake.settle(turn.turnId, { state: "cancelled", persisted: false });
    await flush();
    expect(notifications).toBe(before + 1);
  });

  it("CORE-04-D 订阅生命周期：卸载即停；dispose 后迟到事件不再更新快照", async () => {
    await ctx.presenter.start();
    void ctx.presenter.send("你好");
    const turn = ctx.fake.last();

    let notifications = 0;
    const unsubscribe = ctx.presenter.subscribe(() => { notifications += 1; });
    unsubscribe();
    ctx.fake.delta(turn.turnId, "一");
    expect(notifications).toBe(0);

    const subscribedAgain = ctx.presenter.subscribe(() => { notifications += 1; });
    ctx.fake.delta(turn.turnId, "二");
    expect(notifications).toBe(1);
    subscribedAgain();

    const frozen = ctx.presenter.getSnapshot();
    ctx.presenter.dispose();
    ctx.fake.delta(turn.turnId, "三");
    expect(ctx.presenter.getSnapshot()).toBe(frozen);
    ctx.fake.settle(turn.turnId, { state: "cancelled", persisted: false });
    await flush();
    expect(ctx.presenter.getSnapshot()).toBe(frozen);
  });

  it("start 幂等：StrictMode 双次挂载不会重复装载或重复订阅", async () => {
    const first = ctx.presenter.start();
    const second = ctx.presenter.start();
    expect(second).toBe(first);
    await flush();
    expect(ctx.presenter.getSnapshot().ready).toBe(true);
  });
});

function latestAssistant(presenter: CompanionPresenter): ChatMessage | undefined {
  return [...presenter.getSnapshot().messages].reverse().find((message) => message.role === "assistant");
}
