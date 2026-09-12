import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HookHarness } from "./hookHarness";
import type { ChatMessage } from "../domain/conversation";
import type { CompanionReply } from "../domain/companion";
import { createInMemoryMemoryStore } from "../services/memory/memoryStore";
import type { MemoryRecord } from "../domain/memory";
import type { VoiceTurnRequest } from "../domain/voiceRuntime";

const mocks = vi.hoisted(() => {
  const state: any = {
    hook: null,
    storage: null,
    streamChat: vi.fn(),
    currentStream: null,
    presenter: null,
    tick: null,
    extractor: {
      extract: vi.fn(async () => [] as MemoryRecord[]),
      summarize: vi.fn(async () => ""),
    },
  };
  state.openStorage = vi.fn(async () => state.storage);
  state.loadProvider = vi.fn(async (_storage: unknown, fallback: unknown) => ({ ...(fallback as object), apiKey: "test-key" }));
  state.secretStore = { secure: vi.fn(async () => false) };
  state.appended = [];
  return state;
});

vi.mock("react", () => ({
  useRef: (initial: unknown) => mocks.hook.useRef(initial),
  useState: (initial: unknown) => mocks.hook.useState(initial),
  useMemo: (factory: () => unknown, deps: readonly unknown[]) => mocks.hook.useMemo(factory, deps),
  useCallback: (factory: unknown, deps: readonly unknown[]) => mocks.hook.useCallback(factory, deps),
  useEffect: (effect: () => void | (() => void), deps: readonly unknown[]) => mocks.hook.useEffect(effect, deps),
  useSyncExternalStore: (subscribe: (listener: () => void) => () => void, getSnapshot: () => unknown) =>
    mocks.hook.useSyncExternalStore(subscribe, getSnapshot),
}));

// CORE-04：Hook 现在只经 useService 取 Presenter。测试直接给出生产 Presenter，
// 于是同一批断言同时验证「Presenter 行为」与「Hook 只是订阅 + 派发」。
vi.mock("../app/kernelContext", () => ({
  useService: (token: { key: string }) => (
    token.key === "presentation.companion" ? mocks.presenter : null
  ),
}));

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: async () => false,
  requestPermission: async () => "denied",
  sendNotification: async () => undefined,
}));

vi.mock("../services/storage", () => ({
  openStorage: (...args: unknown[]) => mocks.openStorage(...args),
  loadProvider: (...args: unknown[]) => mocks.loadProvider(...args),
  saveProvider: vi.fn(async () => undefined),
  secretStore: mocks.secretStore,
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

vi.mock("../services/memory/extractor", () => ({ createModelMemoryExtractor: () => mocks.extractor, formatTranscript: () => "" }));
vi.mock("../services/stickers/library", () => ({ loadStickers: async () => [] }));
// 只替 streamChat；describeChatRequest 等保留真实实现——Trace 报的 endpoint
// 必须是 providerClient 真正会用的那个。
vi.mock("../services/providerClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/providerClient")>()),
  streamChat: (...args: unknown[]) => mocks.streamChat(...args),
  sendChat: vi.fn(),
  isAbortError: (error: unknown) => error instanceof DOMException && error.name === "AbortError",
}));

import { useCompanionSession } from "./useCompanionSession";
import { createCompanionPresenter } from "../presentation/companionPresenter";
import { createCompanionRuntime } from "../services/runtime/companionRuntime";
import { createStreamChatProvider } from "../services/runtime/providerAdapter";
import { createProviderSettings } from "../services/runtime/providerSettings";
import { PROVIDER_PRESETS } from "../domain/providers";

const providerReply: CompanionReply = {
  japaneseText: "聞こえたよ。",
  chineseTranslation: "我听到了。",
  mood: "neutral",
};

function createStorage() {
  const rows: ChatMessage[] = [];
  const settings = new Map<string, string>();
  return {
    kind: "local" as const,
    rows,
    listMessages: async () => rows.slice(-200),
    appendMessage: async (message: ChatMessage) => {
      const index = rows.findIndex((item) => item.id === message.id);
      if (index >= 0) rows[index] = message;
      else rows.push(message);
      mocks.appended.push({ ...message });
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
    getSetting: async (key: string) => settings.get(key) ?? null,
    setSetting: async (key: string, value: string) => { settings.set(key, value); },
  };
}

function startStream() {
  let resolve!: (reply: CompanionReply) => void;
  let reject!: (error: unknown) => void;
  const calls = mocks.streamChat.mock.calls;
  const onPartial = calls[calls.length - 1]?.[3] as ((partial: any) => void) | undefined;
  const promise = new Promise<CompanionReply>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  mocks.currentStream = { resolve, reject, onPartial };
  return promise;
}

async function flushMicrotasks() {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

/**
 * CORE-06：全仓只有一条编排路径。Runtime 直接注入 Presenter，不再有 legacy 分支，
 * 也不再经 `activeRuntimeServices` 这个过渡槽——同一批断言现在只验这条唯一路径。
 */
describe("useCompanionSession voice persistence boundary", () => {
  beforeEach(() => {
    mocks.hook = new HookHarness();
    mocks.storage = createStorage();
    mocks.appended.length = 0;
    mocks.extractor.extract.mockReset().mockResolvedValue([]);
    mocks.extractor.summarize.mockReset().mockResolvedValue("");
    mocks.streamChat.mockReset();
    mocks.streamChat.mockImplementation((...args: unknown[]) => {
      const promise = startStream();
      if (args[3]) mocks.currentStream.onPartial = args[3];
      return promise;
    });

    const settings = createProviderSettings(PROVIDER_PRESETS[1]);
    const runtime = createCompanionRuntime({
      provider: createStreamChatProvider({
        getConfig: () => settings.get(),
        getStickers: () => settings.getStickers(),
      }),
      storage: mocks.storage,
      timers: { setTimeout: (fn: () => void) => { mocks.deliveryTimeout = fn; return fn; }, clearTimeout: () => { mocks.deliveryTimeout = null; } },
    });
    mocks.tick = null;
    mocks.presenter = createCompanionPresenter({
      loadStorage: async () => mocks.storage,
      notifier: { notify: async () => false },
      runtime: { runtime, settings },
      // 主动消息 tick 由注入的计时器驱动，测试不需要 stub window。
      interval: { set: (fn: () => void) => { mocks.tick = fn; return 1; }, clear: () => { mocks.tick = null; } },
      // 本文件关心「每轮之后写回已落库」的重试语义；生产默认 8 轮阈值由维护队列自己的用例包覆盖。
      maintenanceTurnThreshold: 1,
    });
  });

  afterEach(() => {
    mocks.hook.cleanup();
  });

  it("完整语音回复要等播放 drained 才落库并启动记忆；中断只留 interrupted", async () => {
    const render = () => useCompanionSession();
    const harness = mocks.hook as HookHarness;
    let session = harness.render(render);
    await flushMicrotasks();
    session = harness.rerender();

    const firstController = new AbortController();
    const firstRequest: VoiceTurnRequest = { turnId: 1, signal: firstController.signal };
    const firstSend = session.send("第一轮", "voice", undefined, firstRequest);
    // LLM-03：send 现在要先按本轮 query 检索记忆，再发起 Provider 请求，
    // 所以这里必须等微任务推进到流真正建立之后才能拿到 onPartial。
    await flushMicrotasks();
    const firstStream = mocks.currentStream as { resolve: (reply: CompanionReply) => void; onPartial: (partial: any) => void };
    firstStream.onPartial({ japaneseText: "聞こえたよ。", chineseTranslation: "", mood: "neutral", japaneseComplete: false });
    firstStream.resolve(providerReply);
    await firstSend;
    await flushMicrotasks();

    expect(mocks.appended.filter((message: ChatMessage) => message.role === "assistant")).toHaveLength(0);
    expect(mocks.extractor.extract).not.toHaveBeenCalled();

    firstRequest.onPlaybackComplete?.();
    await flushMicrotasks();
    const completed = mocks.storage.rows.find((message: ChatMessage) => message.role === "assistant");
    // 断言的是「这条不是被打断的」这个契约，而不是某条实现恰好把字段留空。
    // 旧编排不写 completion，Runtime 显式写 "complete"；两者经 SQLite 往返后
    // 都会还原成 undefined（completion_status 默认 complete，只有 interrupted 会映射回来）。
    expect(completed?.completion).not.toBe("interrupted");
    expect(completed?.playbackStatus).toBe("played");
    expect(mocks.extractor.extract).toHaveBeenCalledTimes(1);

    const secondController = new AbortController();
    const secondRequest: VoiceTurnRequest = { turnId: 2, signal: secondController.signal };
    const secondSend = session.send("第二轮", "voice", undefined, secondRequest);
    await flushMicrotasks();
    const secondStream = mocks.currentStream as { resolve: (reply: CompanionReply) => void };
    secondStream.resolve(providerReply);
    await secondSend;
    await flushMicrotasks();
    secondController.abort();
    await flushMicrotasks();

    const interrupted = mocks.storage.rows.filter((message: ChatMessage) => message.turnId === 2 && message.role === "assistant");
    expect(interrupted).toHaveLength(1);
    expect(interrupted[0]).toMatchObject({ completion: "interrupted", playbackStatus: "unknown" });
    expect(mocks.extractor.extract).toHaveBeenCalledTimes(1);
  });

  it("文本 send 不依赖 VoiceTurnRequest 即可展示、保存并恢复下一轮", async () => {
    const render = () => useCompanionSession();
    const harness = mocks.hook as HookHarness;
    let session = harness.render(render);
    await flushMicrotasks();
    session = harness.rerender();

    const firstSend = session.send("第一轮文本", "text");
    await flushMicrotasks();
    const firstStream = mocks.currentStream as {
      resolve: (reply: CompanionReply) => void;
      onPartial: (partial: any) => void;
    };
    firstStream.onPartial({
      japaneseText: "聞こえた",
      chineseTranslation: "",
      mood: "neutral",
      japaneseComplete: false,
    });
    firstStream.resolve(providerReply);
    // toMatchObject 而非 toEqual：断言的是回复内容一致，不是返回对象的字段
    // 集合逐字相同。Runtime 侧的回复经 ReplyEnvelopeV1 还原，会多出协议里
    // 的可选字段（sticker、memoryCandidates 等），内容并无差别。
    await expect(firstSend).resolves.toMatchObject(providerReply);
    await flushMicrotasks();

    session = harness.rerender();
    expect(session.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "assistant", source: "text", content: providerReply.japaneseText }),
    ]));
    expect(mocks.storage.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "assistant", source: "text", content: providerReply.japaneseText }),
    ]));
    // 断言的是「这一轮没有语音回合号」，而不是「第六个参数整体为 undefined」。
    // 旧编排文本轮不传 options；Runtime 总是带一个 AbortSignal，因此文本轮也能
    // 在网络层被取消——这是能力增加，不是行为退化。
    expect((mocks.streamChat.mock.calls[0][5] as { turnId?: number } | undefined)?.turnId)
      .toBeUndefined();

    const secondSend = session.send("第二轮文本", "text");
    await flushMicrotasks();
    const secondStream = mocks.currentStream as { resolve: (reply: CompanionReply) => void };
    secondStream.resolve(providerReply);
    await expect(secondSend).resolves.toMatchObject(providerReply);
    await flushMicrotasks();
    session = harness.rerender();

    expect(mocks.storage.rows.filter((message: ChatMessage) => (
      message.role === "assistant" && !message.error
    ))).toHaveLength(2);
    expect(session.messages.filter((message: ChatMessage) => (
      message.role === "assistant" && message.source === "text"
    ))).toHaveLength(3);
  });

  it("文本 Provider 错误与断流不保存为完整成功回复，且下一轮仍可用", async () => {
    const render = () => useCompanionSession();
    const harness = mocks.hook as HookHarness;
    let session = harness.render(render);
    await flushMicrotasks();
    session = harness.rerender();

    mocks.streamChat
      .mockImplementationOnce(async () => {
        throw new Error("provider unavailable");
      })
      .mockImplementationOnce(async (...args: unknown[]) => {
        const onPartial = args[3] as ((partial: any) => void) | undefined;
        onPartial?.({
          japaneseText: "半句だけ",
          chineseTranslation: "",
          mood: "neutral",
          japaneseComplete: false,
        });
        throw new Error("connection reset");
      });

    await expect(session.send("错误轮", "text")).resolves.toBeNull();
    await flushMicrotasks();
    session = harness.rerender();
    await expect(session.send("断流轮", "text")).resolves.toBeNull();
    await flushMicrotasks();
    session = harness.rerender();

    expect(mocks.storage.rows.filter((message: ChatMessage) => (
      message.role === "assistant" && !message.error
    ))).toHaveLength(0);
    expect(mocks.storage.rows.filter((message: ChatMessage) => (
      message.role === "assistant" && message.error
    ))).toHaveLength(2);
    expect(session.messages.filter((message: ChatMessage) => (
      message.role === "assistant" && message.error
    ))).toHaveLength(2);

    const recoverySend = session.send("恢复轮", "text");
    await flushMicrotasks();
    const recoveryStream = mocks.currentStream as { resolve: (reply: CompanionReply) => void };
    recoveryStream.resolve(providerReply);
    await expect(recoverySend).resolves.toMatchObject(providerReply);
    await flushMicrotasks();

    expect(mocks.storage.rows.filter((message: ChatMessage) => (
      message.role === "assistant" && !message.error
    ))).toHaveLength(1);
  });

  it("模式配置写入 settings，重载后保留模式参数；退出场景清掉临时配置", async () => {
    const render = () => useCompanionSession();
    let harness = mocks.hook as HookHarness;
    let session = harness.render(render);
    await flushMicrotasks();
    session = harness.rerender();

    await session.setModeConfig({
      schemaVersion: 1,
      mode: "scenario_practice",
      targetLanguage: "en-US",
      correctionPreference: "gentle",
      replyLength: "short",
      scenario: {
        scenarioId: "interview",
        title: "面试",
        setting: "会议室",
        temporaryIdentity: "候选人",
        goal: "完成自我介绍",
        exitCondition: "用户说退出",
      },
    });
    session = harness.rerender();
    expect(session.modeConfig.mode).toBe("scenario_practice");
    expect(JSON.parse((await mocks.storage.getSetting("llm.mode"))!).scenario.temporaryIdentity).toBe("候选人");

    harness.cleanup();
    mocks.hook = new HookHarness();
    harness = mocks.hook as HookHarness;
    session = harness.render(render);
    await flushMicrotasks();
    session = harness.rerender();
    expect(session.modeConfig).toMatchObject({ mode: "scenario_practice", targetLanguage: "en-US" });

    await session.exitScenario();
    session = harness.rerender();
    expect(session.modeConfig.mode).toBe("companion");
    expect(session.modeConfig.scenario).toBeUndefined();
    expect(JSON.parse((await mocks.storage.getSetting("llm.mode"))!).mode).toBe("companion");
  });

  it("模式保存失败时保留原配置并暴露错误，不伪称退出场景成功", async () => {
    const render = () => useCompanionSession();
    const harness = mocks.hook as HookHarness;
    let session = harness.render(render);
    await flushMicrotasks();
    session = harness.rerender();

    await session.setModeConfig({
      schemaVersion: 1,
      mode: "scenario_practice",
      targetLanguage: "en-US",
      correctionPreference: "gentle",
      replyLength: "short",
      scenario: {
        scenarioId: "interview",
        title: "面试",
        setting: "会议室",
        temporaryIdentity: "候选人",
        goal: "完成自我介绍",
        exitCondition: "用户说退出",
      },
    });
    session = harness.rerender();
    const before = JSON.parse(JSON.stringify(session.modeConfig));
    const saved = await mocks.storage.getSetting("llm.mode");
    const originalSetSetting = mocks.storage.setSetting;
    mocks.storage.setSetting = vi.fn(async (key: string, value: string) => {
      if (key === "llm.mode") throw new Error("磁盘只读");
      return originalSetSetting(key, value);
    });

    await expect(session.exitScenario()).rejects.toThrow("磁盘只读");
    session = harness.rerender();

    expect(session.modeConfig).toEqual(before);
    expect(await mocks.storage.getSetting("llm.mode")).toBe(saved);
    expect(session.storageError).toContain("模式设置保存失败：磁盘只读");

    mocks.storage.setSetting = originalSetSetting;
    await session.exitScenario();
    session = harness.rerender();
    expect(session.modeConfig.mode).toBe("companion");
    expect(session.storageError).toBe("");
  });

  it("连续两次模式保存失败后成功，只清理模式错误并保留其它存储错误", async () => {
    let failInitialRead = true;
    const originalGetSetting = mocks.storage.getSetting;
    mocks.storage.getSetting = vi.fn(async (key: string) => {
      if (failInitialRead && key === "voice.backend") throw new Error("数据库读取失败");
      return originalGetSetting(key);
    });

    const render = () => useCompanionSession();
    const harness = mocks.hook as HookHarness;
    let session = harness.render(render);
    await flushMicrotasks();
    failInitialRead = false;
    session = harness.rerender();
    expect(session.storageError).toContain("数据库读取失败");

    const originalSetSetting = mocks.storage.setSetting;
    let failureMessage = "quota-A";
    mocks.storage.setSetting = vi.fn(async (key: string, value: string) => {
      if (key === "llm.mode") throw new Error(failureMessage);
      return originalSetSetting(key, value);
    });
    const nextMode = {
      schemaVersion: 1 as const,
      mode: "oral_practice" as const,
      targetLanguage: "en-US" as const,
      correctionPreference: "gentle" as const,
      replyLength: "short" as const,
    };

    await expect(session.setModeConfig(nextMode)).rejects.toThrow("quota-A");
    failureMessage = "quota-B";
    await expect(session.setModeConfig(nextMode)).rejects.toThrow("quota-B");
    session = harness.rerender();
    expect(session.storageError).toContain("quota-A");
    expect(session.storageError).toContain("quota-B");

    mocks.storage.setSetting = originalSetSetting;
    await session.setModeConfig(nextMode);
    session = harness.rerender();
    expect(session.modeConfig).toMatchObject({ mode: "oral_practice", targetLanguage: "en-US" });
    expect(session.storageError).toBe("数据库读取失败");
  });
  // CORE-06：以下用例原先只在 kernel 路径下跑，现在 kernel 就是唯一路径。
  async function readySession() {
      mocks.hook.render(() => useCompanionSession());
      await flushMicrotasks();
      return mocks.hook.rerender() as ReturnType<typeof useCompanionSession>;
    }

    it("新 submit 取消旧轮，旧 chunk 与结算不清除新轮 pending", async () => {
      const session = await readySession();
      const first = session.send("第一轮");
      await flushMicrotasks();
      const old = mocks.currentStream;
      old.onPartial({ japaneseText: "旧片段", chineseTranslation: "", mood: "neutral" });
      await flushMicrotasks();
      expect(mocks.hook.rerender().messages.some((m: ChatMessage) => m.content === "旧片段")).toBe(true);
      const second = session.send("第二轮");
      await flushMicrotasks();
      const next = mocks.currentStream;
      expect(next).not.toBe(old);
      await first;
      expect(mocks.hook.rerender().sending).toBe(true);
      expect(mocks.hook.rerender().messages.some((m: ChatMessage) => m.pending)).toBe(true);
      old.onPartial({ japaneseText: "不许出现的迟到内容", chineseTranslation: "", mood: "neutral" });
      old.resolve({ ...providerReply, japaneseText: "不许出现的迟到内容" });
      next.resolve(providerReply);
      await second;
      expect(mocks.storage.rows.some((m: ChatMessage) => m.content.includes("迟到"))).toBe(false);
      expect(mocks.hook.rerender().messages.some((m: ChatMessage) => m.pending)).toBe(false);
      expect(mocks.hook.rerender().sending).toBe(false);
    });

    it.each(["failed", "timeout"])("语音 %s 保留 interrupted/unknown，重复回执不重复维护", async (ending) => {
      const session = await readySession();
      const request: VoiceTurnRequest = { turnId: 42, signal: new AbortController().signal };
      const sent = session.send("语音", "voice", undefined, request);
      await flushMicrotasks();
      mocks.currentStream.resolve(providerReply);
      await sent;
      expect(mocks.storage.rows.filter((m: ChatMessage) => m.role === "assistant")).toHaveLength(0);
      if (ending === "failed") request.onPlaybackFailed?.();
      else mocks.deliveryTimeout();
      for (let i = 0; i < 4; i++) await flushMicrotasks();
      const rows = mocks.storage.rows.filter((m: ChatMessage) => m.role === "assistant" && !m.error);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ completion: "interrupted", playbackStatus: "unknown", turnId: 42 });
      request.onPlaybackComplete?.();
      await flushMicrotasks();
      expect(mocks.extractor.extract).not.toHaveBeenCalled();
      expect(mocks.hook.rerender().messages.some((m: ChatMessage) => m.pending)).toBe(false);
    });

    it("写库持续失败仍展示错误并释放发送状态，恢复存储后可重发", async () => {
      const session = await readySession();
      const append = mocks.storage.appendMessage;
      mocks.storage.appendMessage = async () => { throw new Error("磁盘不可写"); };
      const sent = session.send("第一轮");
      await flushMicrotasks();
      mocks.currentStream.resolve(providerReply);
      await sent;
      const failed = mocks.hook.rerender();
      expect(failed.sending).toBe(false);
      expect(failed.messages.some((m: ChatMessage) => m.error && m.content.includes("STORAGE_FAILED"))).toBe(true);
      expect(failed.messages.some((m: ChatMessage) => m.pending)).toBe(false);
      expect(mocks.extractor.extract).not.toHaveBeenCalled();
      mocks.storage.appendMessage = append;
      const retry = failed.send("重发");
      await flushMicrotasks();
      mocks.currentStream.resolve(providerReply);
      await retry;
      expect(mocks.storage.rows.some((m: ChatMessage) => m.role === "assistant" && !m.error)).toBe(true);
    });

    it("真实上下文预算失败可见，不请求 Provider，缩短输入后恢复", async () => {
      const session = await readySession();
      await session.send("字".repeat(40000));
      const failed = mocks.hook.rerender();
      expect(failed.messages.some((m: ChatMessage) => m.error && m.content.includes("预算"))).toBe(true);
      expect(failed.sending).toBe(false);
      expect(mocks.streamChat).not.toHaveBeenCalled();
      const retry = failed.send("短句");
      await flushMicrotasks();
      mocks.currentStream.resolve(providerReply);
      await retry;
      expect(mocks.hook.rerender().sending).toBe(false);
    });

    it("抽取未完成也返回正文；关闭维护使在途候选和后续发送不写记忆", async () => {
      const session = await readySession();
      let finishExtraction!: (records: MemoryRecord[]) => void;
      mocks.extractor.extract.mockImplementation(() => new Promise((resolve) => { finishExtraction = resolve; }));
      mocks.storage.addMemories = vi.fn();
      const sent = session.send("测试");
      await flushMicrotasks();
      mocks.currentStream.resolve(providerReply);
      await sent;
      expect(mocks.hook.rerender().sending).toBe(false);
      expect(mocks.extractor.extract).toHaveBeenCalledTimes(1);
      await session.setMemoryExtractionEnabled(false);
      finishExtraction([{ id: "candidate", content: "喜欢咖啡", category: "preference" } as unknown as MemoryRecord]);
      await flushMicrotasks();
      expect(mocks.storage.addMemories).not.toHaveBeenCalled();
      const next = mocks.hook.rerender().send("下一轮");
      await flushMicrotasks();
      mocks.currentStream.resolve(providerReply);
      await next;
      expect(mocks.extractor.extract).toHaveBeenCalledTimes(1);
    });

    it("摘要悬挂不阻塞正文，关闭维护后不保存迟到摘要", async () => {
      for (let i = 0; i < 60; i++) mocks.storage.rows.push({
        id: `history-${i}`, role: i % 2 ? "assistant" : "user", content: "历史", createdAt: 1000 + i, time: "00:00",
      });
      const session = await readySession();
      let finishSummary!: (text: string) => void;
      mocks.extractor.summarize.mockImplementation(() => new Promise((resolve) => { finishSummary = resolve; }));
      mocks.storage.saveSummary = vi.fn();
      const sent = session.send("测试");
      await flushMicrotasks();
      mocks.currentStream.resolve(providerReply);
      await sent;
      await flushMicrotasks();
      expect(mocks.extractor.summarize).toHaveBeenCalledTimes(1);
      expect(mocks.hook.rerender().sending).toBe(false);
      await session.setMemoryExtractionEnabled(false);
      finishSummary("迟到摘要");
      await flushMicrotasks();
      expect(mocks.storage.saveSummary).not.toHaveBeenCalled();
    });

    it("V2 候选走 Writeback 重试，下一轮重复候选不堆叠", async () => {
      const store = createInMemoryMemoryStore();
      mocks.storage.memoryV2 = store;
      const session = await readySession();
      mocks.extractor.extract.mockResolvedValue([{ content: "喜欢咖啡", category: "喜好" }]);
      store.failNextSave = true;
      const first = session.send("咖啡");
      await flushMicrotasks();
      mocks.currentStream.resolve(providerReply);
      await first;
      for (let i = 0; i < 3; i++) await flushMicrotasks();
      expect((await store.load()).records).toHaveLength(0);
      const second = mocks.hook.rerender().send("咖啡");
      await flushMicrotasks();
      mocks.currentStream.resolve(providerReply);
      await second;
      for (let i = 0; i < 5; i++) await flushMicrotasks();
      const records = (await store.load()).records;
      expect(records).toHaveLength(1);
      expect(records[0].content).toBe("喜欢咖啡");
      expect(records[0].sourceMessageIds.length).toBeGreaterThanOrEqual(2);
    });

    it("完整语音重复回执只启动一次后台维护", async () => {
      const session = await readySession();
      const request: VoiceTurnRequest = { turnId: 7, signal: new AbortController().signal };
      const sent = session.send("测试", "voice", undefined, request);
      await flushMicrotasks();
      mocks.currentStream.resolve(providerReply);
      await sent;
      request.onPlaybackComplete?.();
      request.onPlaybackComplete?.();
      for (let i = 0; i < 4; i++) await flushMicrotasks();
      request.onPlaybackComplete?.();
      await flushMicrotasks();
      expect(mocks.extractor.extract).toHaveBeenCalledTimes(1);
    });

    it("主动 tick 由 Runtime 落库，只产生 assistant 消息且遵守配额", async () => {
      const tick = () => mocks.tick?.();
      vi.spyOn(Date.prototype, "getHours").mockReturnValue(12);
      try {
        const session = await readySession();
        await session.setProactive({ enabled: true, quietStartHour: 23, quietEndHour: 8 });
        mocks.hook.rerender();
        tick();
        for (let i = 0; i < 4; i++) await flushMicrotasks();
        expect(mocks.streamChat).toHaveBeenCalledTimes(1);
        mocks.currentStream.resolve(providerReply);
        for (let i = 0; i < 8; i++) await flushMicrotasks();
        expect(mocks.storage.rows).toHaveLength(1);
        expect(mocks.storage.rows[0]).toMatchObject({ role: "assistant", source: "proactive", runtimeTurnId: expect.any(String) });
        mocks.hook.rerender();
        tick();
        await flushMicrotasks();
        expect(mocks.streamChat).toHaveBeenCalledTimes(1);
        mocks.storage.countProactiveSince = async () => 6;
        tick();
        await flushMicrotasks();
        expect(mocks.streamChat).toHaveBeenCalledTimes(1);
      } finally {
        mocks.hook.cleanup();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
      }
  });

});
