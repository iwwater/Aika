import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HookHarness } from "./hookHarness";
import type { ChatMessage } from "../domain/conversation";
import type { CompanionReply } from "../domain/companion";
import type { MemoryRecord } from "../domain/memory";
import type { VoiceTurnRequest } from "../domain/voiceRuntime";

const mocks = vi.hoisted(() => {
  const state: any = {
    hook: null,
    storage: null,
    streamChat: vi.fn(),
    currentStream: null,
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
vi.mock("../services/providerClient", () => ({
  streamChat: (...args: unknown[]) => mocks.streamChat(...args),
  sendChat: vi.fn(),
  isAbortError: (error: unknown) => error instanceof DOMException && error.name === "AbortError",
}));

import { useCompanionSession } from "./useCompanionSession";
import { createCompanionRuntime } from "../services/runtime/companionRuntime";
import { createStreamChatProvider } from "../services/runtime/providerAdapter";
import { createProviderSettings } from "../services/runtime/providerSettings";
import { installRuntimeServices, resetInstalledRuntimeServices } from "../services/runtime/activeRuntime";
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
 * CORE-03-A：同一份测试跑新旧两条编排。
 *
 * 两条路径的行为差异只能靠这个跑出来，靠读代码是读不出来的——旧编排在 Hook 里，
 * 新编排在 CompanionRuntime 里，各写各的打断、迟到结果与落库。
 */
describe.each(["legacy", "kernel"] as const)("useCompanionSession voice persistence boundary (%s)", (orchestrator) => {
  beforeEach(() => {
    mocks.hook = new HookHarness();
    mocks.storage = createStorage();
    mocks.appended.length = 0;
    mocks.extractor.extract.mockClear();
    mocks.extractor.summarize.mockClear();
    mocks.streamChat.mockReset();
    mocks.streamChat.mockImplementation((...args: unknown[]) => {
      const promise = startStream();
      if (args[3]) mocks.currentStream.onPartial = args[3];
      return promise;
    });

    resetInstalledRuntimeServices();
    if (orchestrator === "kernel") {
      // 直接装 Runtime，不经内核：这里验的是 Hook 的两条路径，
      // 内核装配由 app/plugins/plugins.test.ts 负责。
      const settings = createProviderSettings(PROVIDER_PRESETS[1]);
      installRuntimeServices({
        settings,
        runtime: createCompanionRuntime({
          provider: createStreamChatProvider({
            getConfig: () => settings.get(),
            getStickers: () => settings.getStickers(),
          }),
          storage: mocks.storage,
        }),
      });
    }
  });

  afterEach(() => {
    mocks.hook.cleanup();
    resetInstalledRuntimeServices();
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
});
