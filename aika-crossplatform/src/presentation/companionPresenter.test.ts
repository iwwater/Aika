import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../domain/conversation";
import type { SessionSummary } from "../domain/summary";
import type { ReplyEnvelopeV1 } from "../domain/companion";
import { PROVIDER_PRESETS } from "../domain/providers";
import type {
  CompanionRuntime, RuntimeEvent, SubmitRequest, TurnSettlement,
} from "../services/runtime/companionRuntime";
import { createProviderSettings } from "../services/runtime/providerSettings";
import { createMemoryRepository } from "../services/memory/memoryRepository";
import type { MemoryAccess } from "../services/memory/tokens";
import { createInMemoryMemoryStore } from "../services/memory/memoryStore";
import { createMemoryV2 } from "../domain/memory";
import { createMemoryTraceSink } from "../services/trace/memoryTraceSink";
import { createTraceRecorder } from "../services/trace/traceRecorder";
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
  /** 提交过的每一轮，settle 后也留痕——`last()` 只看在途轮，数不出「有没有多提交」。 */
  submitted: string[];
}

function createFakeRuntime(): FakeRuntime {
  const listeners = new Set<(event: RuntimeEvent) => void>();
  const turns = new Map<string, FakeTurn>();
  const cancelled: string[] = [];
  const submitted: string[] = [];
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
      submitted.push(turnId);
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
    submitted,
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

function createStorage(seed: { summaries?: SessionSummary[] } = {}) {
  const rows: ChatMessage[] = [];
  const summaries: SessionSummary[] = [...(seed.summaries ?? [])];
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
    deleteMessages: async (ids: readonly string[]) => {
      const doomed = new Set(ids);
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        if (doomed.has(rows[index].id)) rows.splice(index, 1);
      }
    },
    clearMessages: async () => { rows.length = 0; },
    listMemories: async () => [],
    addMemories: async () => undefined,
    setMemoryStatus: async () => undefined,
    deleteMemory: async () => undefined,
    summaries,
    latestSummary: async () => (summaries.length ? summaries[summaries.length - 1] : null),
    saveSummary: async (summary: SessionSummary) => { summaries.push(summary); },
    deleteSummaries: async () => { summaries.length = 0; },
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

/**
 * 记忆侧用**生产仓储**跑在内存 store 上，不手搓假仓储：
 * 撤回联动要验的是 forget 的真实语义（落抑制标记、状态判定），假的证明不了。
 */
function setup(options: {
  memories?: readonly ReturnType<typeof createMemoryV2>[];
  summaries?: SessionSummary[];
  /** 注入 Trace 时同时给出 sink，便于断言记了什么。 */
  trace?: { sink: ReturnType<typeof createMemoryTraceSink> };
  extractor?: { extract(): Promise<unknown[]>; summarize(): Promise<string> };
} = {}) {
  const storage = createStorage({ summaries: options.summaries });
  const fake = createFakeRuntime();
  const settings = createProviderSettings(PROVIDER_PRESETS[1]);
  const seeded = (options.memories ?? []).flatMap((record) => (record ? [record] : []));
  const store = createInMemoryMemoryStore(seeded.length ? { initial: { records: seeded } } : {});
  const repository = createMemoryRepository({ store });
  // 与 memoryPlugin 同形状的能力包：changed 订阅者真的会被扇出到，
  // 否则「管理页改完右栏跟着变」这条只能靠读代码相信（FE-11-F）。
  const changedListeners = new Set<() => void>();
  const access: MemoryAccess = {
    repository,
    onInvalidate: () => () => undefined,
    onChanged(listener) {
      changedListeners.add(listener);
      return () => {
        changedListeners.delete(listener);
      };
    },
    notifyChanged() {
      for (const listener of [...changedListeners]) listener();
    },
  };
  const presenter: CompanionPresenter = createCompanionPresenter({
    loadStorage: async () => storage,
    notifier: { notify: async () => false },
    loadStickers: async () => [],
    extractor: (options.extractor ?? { extract: async () => [], summarize: async () => "" }) as never,
    runtime: { runtime: fake.runtime, settings },
    ...(options.trace
      ? {
        trace: createTraceRecorder({
          sink: options.trace.sink,
          clock: () => 1_700_000_000_000,
        }),
      }
      : {}),
    ...(options.memories ? { memoryAccess: access } : {}),
  });
  return { presenter, storage, fake, repository, notifyChanged: () => access.notifyChanged() };
}

/**
 * 把一轮的两行按真实形状落进 fake 存储。
 *
 * 真 Runtime 自己落库（生成前落用户消息、完成后落回复），fake Runtime 不落；
 * 撤回/重新生成验的正是「库里那几行怎么消失」，所以这里得先有行。
 */
function seedTurnRows(
  storage: ReturnType<typeof createStorage>,
  runtimeTurnId: string,
  askedAt = 1000,
  suffix = "1",
): { askedId: string; repliedId: string } {
  const askedId = `asked-${suffix}`;
  const repliedId = `replied-${suffix}`;
  storage.rows.push({
    id: askedId, role: "user", content: "你好", source: "text",
    createdAt: askedAt, time: "00:00", runtimeTurnId,
  });
  storage.rows.push({
    id: repliedId, role: "assistant", content: "こんにちは", japaneseText: "こんにちは",
    chineseTranslation: "你好", source: "text", createdAt: askedAt + 1, time: "00:00", runtimeTurnId,
  });
  return { askedId, repliedId };
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

  it("重试：先整轮删掉再用原话重投，库里不留重复用户消息", async () => {
    await ctx.presenter.start();
    const sent = ctx.presenter.send("你好");
    const turn = ctx.fake.last();
    // 真 Runtime 在生成前就把用户那句话落库（companionRuntime 的 persist(turn, asked)），
    // fake Runtime 不落库；这里按真实形状补上，含同号的 runtimeTurnId。
    ctx.storage.rows.push({
      id: "asked-1", role: "user", content: "你好", source: "text",
      createdAt: Date.now(), time: "00:00", runtimeTurnId: turn.turnId,
    });

    ctx.fake.error(turn.turnId, "PROVIDER_FAILED", "连接被重置");
    ctx.fake.settle(turn.turnId, { state: "failed", persisted: true, errorCode: "PROVIDER_FAILED" });
    await sent;
    await flush();

    const failure = ctx.presenter.getSnapshot().messages.find((message) => message.error);
    expect(failure).toBeDefined();
    expect(ctx.storage.rows.filter((row) => row.role === "user")).toHaveLength(1);

    const retried = ctx.presenter.retry(failure!.id);
    await flush();

    // 失败轮的两行都从库里消失了，界面上也不再有失败气泡。
    expect(ctx.storage.rows.some((row) => row.id === failure!.id)).toBe(false);
    expect(ctx.storage.rows.some((row) => row.id === "asked-1")).toBe(false);
    expect(ctx.presenter.getSnapshot().messages.some((message) => message.error)).toBe(false);

    // 用同一句原话重投，不是发一句空话。
    const second = ctx.fake.last();
    expect(second.turnId).not.toBe(turn.turnId);
    expect(second.request.text).toBe("你好");

    ctx.fake.generated(second.turnId, envelope("こんにちは", "你好"));
    ctx.fake.settle(second.turnId, { state: "completed", persisted: true });
    await retried;
    await flush();

    expect(ctx.presenter.getSnapshot().messages.some((message) => message.error)).toBe(false);
    expect(ctx.storage.rows.filter((row) => row.role === "user")).toHaveLength(0);
  });

  it("重试：未知 id、非失败气泡、正在发送中，三种都不动手", async () => {
    await ctx.presenter.start();
    const sent = ctx.presenter.send("你好");
    const first = ctx.fake.last();
    ctx.fake.error(first.turnId, "PROVIDER_FAILED", "连接被重置");
    ctx.fake.settle(first.turnId, { state: "failed", persisted: true, errorCode: "PROVIDER_FAILED" });
    await sent;
    await flush();
    const failure = ctx.presenter.getSnapshot().messages.find((message) => message.error);
    expect(failure).toBeDefined();

    // 未知 id：不存在的消息不能凭空重投。
    await expect(ctx.presenter.retry("不存在")).resolves.toBeNull();
    // 非失败气泡：开场白是 assistant 消息但没有失败，不可重试。
    await expect(ctx.presenter.retry("welcome")).resolves.toBeNull();

    // 正在发送中：新一轮在途时不许再塞一轮进去。
    void ctx.presenter.send("再说一次");
    const second = ctx.fake.last();
    await expect(ctx.presenter.retry(failure!.id)).resolves.toBeNull();

    // 只有上面两次真实 send 提交过，三次 retry 一轮都没多提交。
    expect(ctx.fake.submitted).toEqual([first.turnId, second.turnId]);
    // 失败气泡还在，用户之后仍可重试。
    expect(ctx.presenter.getSnapshot().messages.some((message) => message.id === failure!.id)).toBe(true);
  });

  it("重新生成：成功的那一轮也走先删再投，库里不留重复用户消息", async () => {
    await ctx.presenter.start();
    const sent = ctx.presenter.send("你好");
    const first = ctx.fake.last();
    const rows = seedTurnRows(ctx.storage, first.turnId);
    ctx.fake.generated(first.turnId, envelope("こんにちは", "你好"));
    ctx.fake.settle(first.turnId, { state: "completed", persisted: true });
    await sent;
    await flush();
    expect(ctx.presenter.getSnapshot().messages.some((message) => message.id === rows.repliedId)).toBe(true);

    const again = ctx.presenter.regenerate(rows.repliedId);
    await flush();

    expect(ctx.storage.rows).toHaveLength(0);

    const second = ctx.fake.last();
    expect(second.turnId).not.toBe(first.turnId);
    expect(second.request.text).toBe("你好");
    ctx.fake.generated(second.turnId, envelope("やあ", "嘿"));
    ctx.fake.settle(second.turnId, { state: "completed", persisted: true });
    await again;
    await flush();
    expect(ctx.storage.rows.filter((row) => row.role === "user")).toHaveLength(0);
  });

  it("撤回：整轮从存储与界面消失，timestamps 跟着刷新", async () => {
    await ctx.presenter.start();
    const sent = ctx.presenter.send("你好");
    const turn = ctx.fake.last();
    const rows = seedTurnRows(ctx.storage, turn.turnId);
    ctx.fake.generated(turn.turnId, envelope("こんにちは", "你好"));
    ctx.fake.settle(turn.turnId, { state: "completed", persisted: true });
    await sent;
    await flush();
    expect(ctx.presenter.getSnapshot().relationship.totalMessageCount).toBeGreaterThan(0);

    await ctx.presenter.withdraw(rows.repliedId);
    await flush();

    expect(ctx.storage.rows).toHaveLength(0);
    const snapshot = ctx.presenter.getSnapshot();
    expect(snapshot.messages.some((message) => message.id === rows.repliedId)).toBe(false);
    expect(snapshot.messages.some((message) => message.id === rows.askedId)).toBe(false);
    // 撤回后面没有新的一轮来顺带对齐存储，所以 timestamps 必须当场刷新。
    expect(snapshot.relationship.totalMessageCount).toBe(0);
  });

  it("撤回：开场白删不掉——它从来不落库", async () => {
    await ctx.presenter.start();
    await ctx.presenter.withdraw("welcome");
    await flush();
    expect(ctx.presenter.getSnapshot().messages.some((message) => message.id === "welcome")).toBe(true);
  });

  it("FE-11：管理页改完记忆后，右栏这份列表跟着变", async () => {
    const kept = createMemoryV2({ content: "喜欢咖啡", type: "preference", status: "confirmed" });
    const doomed = createMemoryV2({ content: "住在涩谷", type: "fact", status: "candidate" });
    const local = setup({ memories: [kept, doomed] });
    await local.presenter.start();

    expect(local.presenter.getSnapshot().memories.map((memory) => memory.content).sort())
      .toEqual(["喜欢咖啡", "住在涩谷"].sort());

    // 管理页那边的动作：确认一条、删掉一条，然后喊一声「记忆变了」。
    await local.repository.upsert([{ ...doomed!, status: "confirmed" as const }]);
    await local.repository.forget(kept!.id);
    local.notifyChanged();
    await Promise.resolve();
    await Promise.resolve();

    const memories = local.presenter.getSnapshot().memories;
    // 同一份记忆两处显示各说各话，比不做管理页更糟。
    expect(memories.map((memory) => memory.content)).toEqual(["住在涩谷"]);
    expect(memories[0].status).toBe("confirmed");
  });

  it("撤回连带记忆：来源有交集的候选被遗忘，确认过的保留", async () => {
    const candidate = createMemoryV2({
      content: "最近很累", type: "fact", sourceMessageIds: ["asked-1"], status: "candidate",
    });
    const confirmed = createMemoryV2({
      content: "喜欢咖啡", type: "preference", sourceMessageIds: ["asked-1"], status: "confirmed",
    });
    const unrelated = createMemoryV2({
      content: "在东京住", type: "fact", sourceMessageIds: ["别轮的消息"], status: "candidate",
    });
    const local = setup({ memories: [candidate, confirmed, unrelated] });
    await local.presenter.start();

    const sent = local.presenter.send("你好");
    const turn = local.fake.last();
    const rows = seedTurnRows(local.storage, turn.turnId);
    local.fake.generated(turn.turnId, envelope("こんにちは", "你好"));
    local.fake.settle(turn.turnId, { state: "completed", persisted: true });
    await sent;
    await flush();

    await local.presenter.withdraw(rows.repliedId);
    await flush();

    const left = (await local.repository.list()).map((record) => record.content);
    // 未确认的候选跟着这一轮消失；用户确认过的那条不许被悄悄删掉。
    expect(new Set(left)).toEqual(new Set(["喜欢咖啡", "在东京住"]));
    expect(left).not.toContain("最近很累");
    local.presenter.dispose();
  });

  it("撤回：没有 V2 仓库时只删消息，不报错也不假装联动了", async () => {
    await ctx.presenter.start();
    const sent = ctx.presenter.send("你好");
    const turn = ctx.fake.last();
    const rows = seedTurnRows(ctx.storage, turn.turnId);
    ctx.fake.generated(turn.turnId, envelope("こんにちは", "你好"));
    ctx.fake.settle(turn.turnId, { state: "completed", persisted: true });
    await sent;
    await flush();

    await expect(ctx.presenter.withdraw(rows.repliedId)).resolves.toBeUndefined();
    expect(ctx.presenter.getSnapshot().storageError).toBe("");
    expect(ctx.storage.rows).toHaveLength(0);
  });

  it("回退：锚点留下，它之后的全部消失，timestamps 跟着刷新", async () => {
    await ctx.presenter.start();
    const sent = ctx.presenter.send("你好");
    const turn = ctx.fake.last();
    const rows = seedTurnRows(ctx.storage, turn.turnId);
    ctx.fake.generated(turn.turnId, envelope("こんにちは", "你好"));
    ctx.fake.settle(turn.turnId, { state: "completed", persisted: true });
    await sent;
    await flush();
    expect(ctx.presenter.getSnapshot().relationship.totalMessageCount).toBe(2);

    // 回到用户那句：她的回复要被删掉，用户那句留下。
    await ctx.presenter.rewind(rows.askedId);
    await flush();

    expect(ctx.storage.rows.map((row) => row.id)).toEqual([rows.askedId]);
    const snapshot = ctx.presenter.getSnapshot();
    expect(snapshot.messages.some((message) => message.id === rows.repliedId)).toBe(false);
    expect(snapshot.messages.some((message) => message.id === rows.askedId)).toBe(true);
    expect(snapshot.relationship.totalMessageCount).toBe(1);
  });

  it("回退：锚点之后什么都没有时不动手", async () => {
    await ctx.presenter.start();
    const sent = ctx.presenter.send("你好");
    const turn = ctx.fake.last();
    const rows = seedTurnRows(ctx.storage, turn.turnId);
    ctx.fake.generated(turn.turnId, envelope("こんにちは", "你好"));
    ctx.fake.settle(turn.turnId, { state: "completed", persisted: true });
    await sent;
    await flush();

    await ctx.presenter.rewind(rows.repliedId);
    await flush();
    expect(ctx.storage.rows).toHaveLength(2);
  });

  it("回退连带记忆：与撤回同一条规则（候选走 forget，确认过的保留）", async () => {
    const candidate = createMemoryV2({
      content: "最近很累", type: "fact", sourceMessageIds: ["replied-1"], status: "candidate",
    });
    const confirmed = createMemoryV2({
      content: "喜欢咖啡", type: "preference", sourceMessageIds: ["replied-1"], status: "confirmed",
    });
    const local = setup({ memories: [candidate, confirmed] });
    await local.presenter.start();

    const sent = local.presenter.send("你好");
    const turn = local.fake.last();
    const rows = seedTurnRows(local.storage, turn.turnId);
    local.fake.generated(turn.turnId, envelope("こんにちは", "你好"));
    local.fake.settle(turn.turnId, { state: "completed", persisted: true });
    await sent;
    await flush();

    await local.presenter.rewind(rows.askedId);
    await flush();

    const left = (await local.repository.list()).map((record) => record.content);
    expect(left).toEqual(["喜欢咖啡"]);
    local.presenter.dispose();
  });

  it("回退：摘要不回滚，但覆盖到被删范围时标一个 gap，且不重复标", async () => {
    // 摘要覆盖到 9000，回退点是 1000，被摘要覆盖的消息确实被删了
    const local = setup({ summaries: [{ content: "上周聊过换工作", coversUntil: 9000, createdAt: 9000 }] });
    await local.presenter.start();
    expect(local.presenter.getSnapshot().summary).toBe("上周聊过换工作");

    const sent = local.presenter.send("你好");
    const turn = local.fake.last();
    const rows = seedTurnRows(local.storage, turn.turnId);
    local.fake.generated(turn.turnId, envelope("こんにちは", "你好"));
    local.fake.settle(turn.turnId, { state: "completed", persisted: true });
    await sent;
    await flush();

    await local.presenter.rewind(rows.askedId);
    await flush();

    const summary = local.presenter.getSnapshot().summary ?? "";
    // 原文一字不改地留着，只是后面多了一行说明。
    expect(summary.startsWith("上周聊过换工作")).toBe(true);
    expect(summary).toContain("回退");
    expect(local.storage.summaries).toHaveLength(1);

    // 再回退一次：先真的再跑一轮，让锚点后面确实有东西可删，
    // 否则 rewindPlan 返回 null，根本走不到去重那一步。
    const second = local.presenter.send("再说一次");
    const secondTurn = local.fake.last();
    seedTurnRows(local.storage, secondTurn.turnId, 3000, "2");
    local.fake.generated(secondTurn.turnId, envelope("やあ", "嘿"));
    local.fake.settle(secondTurn.turnId, { state: "completed", persisted: true });
    await second;
    await flush();

    await local.presenter.rewind(rows.askedId);
    await flush();
    const again = local.presenter.getSnapshot().summary ?? "";
    expect(again).toBe(summary);
    expect(local.storage.summaries).toHaveLength(1);
    local.presenter.dispose();
  });

  it("回退：回退点比摘要覆盖范围更新时，摘要一字不动", async () => {
    // 摘要只覆盖到 500，回退点 1000 更新，被覆盖的消息一条都没删
    const local = setup({ summaries: [{ content: "上周聊过换工作", coversUntil: 500, createdAt: 500 }] });
    await local.presenter.start();

    const sent = local.presenter.send("你好");
    const turn = local.fake.last();
    const rows = seedTurnRows(local.storage, turn.turnId);
    local.fake.generated(turn.turnId, envelope("こんにちは", "你好"));
    local.fake.settle(turn.turnId, { state: "completed", persisted: true });
    await sent;
    await flush();

    await local.presenter.rewind(rows.askedId);
    await flush();

    expect(local.presenter.getSnapshot().summary).toBe("上周聊过换工作");
    expect(local.storage.summaries).toEqual([{ content: "上周聊过换工作", coversUntil: 500, createdAt: 500 }]);
    local.presenter.dispose();
  });

  it("memory_extract：候选条数落在这一轮上", async () => {
    const sink = createMemoryTraceSink(20);
    const local = setup({
      trace: { sink },
      extractor: {
        extract: async () => [
          { id: "m1", category: "日常", content: "最近很累", status: "pending", createdAt: 1, updatedAt: 1 },
        ],
        summarize: async () => "",
      },
    });
    await local.presenter.start();
    const sent = local.presenter.send("你好");
    const turn = local.fake.last();
    seedTurnRows(local.storage, turn.turnId);
    local.fake.generated(turn.turnId, envelope("こんにちは", "你好"));
    local.fake.settle(turn.turnId, { state: "completed", persisted: true });
    await sent;
    await flush();

    const [event] = await sink.query({ kind: "memory_extract" });
    expect(event?.kind).toBe("memory_extract");
    if (event?.kind === "memory_extract") {
      expect(event.candidates).toBe(1);
      expect(event.failed).toBe(false);
      // 挂在 Runtime 的轮次 uuid 上，才能和同一轮的其它事件拼成一条时间线。
      expect(event.turnId).toBe(turn.turnId);
    }
    local.presenter.dispose();
  });

  it("memory_extract：抽取抛错时记 failed，而不是干脆不记", async () => {
    const sink = createMemoryTraceSink(20);
    const local = setup({
      trace: { sink },
      extractor: {
        extract: async () => { throw new Error("抽取挂了"); },
        summarize: async () => "",
      },
    });
    await local.presenter.start();
    const sent = local.presenter.send("你好");
    const turn = local.fake.last();
    seedTurnRows(local.storage, turn.turnId);
    local.fake.generated(turn.turnId, envelope("こんにちは", "你好"));
    local.fake.settle(turn.turnId, { state: "completed", persisted: true });
    await sent;
    await flush();

    const [event] = await sink.query({ kind: "memory_extract" });
    // 不记的话，「记忆怎么一条都没有」永远查不出是抽取一直在失败。
    if (event?.kind === "memory_extract") {
      expect(event.failed).toBe(true);
      expect(event.candidates).toBe(0);
    } else {
      expect.unreachable("抽取失败也必须留下一条 memory_extract");
    }
    local.presenter.dispose();
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
