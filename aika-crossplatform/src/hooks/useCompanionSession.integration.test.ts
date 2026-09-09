import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../domain/conversation";
import type { CompanionReply } from "../domain/companion";
import type { MemoryRecord } from "../domain/memory";
import type { VoiceTurnRequest } from "../domain/voiceRuntime";

class HookHarness {
  private slots: Array<{ kind: string; value: any; deps?: readonly unknown[]; cleanup?: () => void }> = [];
  private cursor = 0;
  private renderFunction: (() => unknown) | null = null;
  result: any;

  render(renderFunction: () => unknown) {
    this.renderFunction = renderFunction;
    this.cursor = 0;
    this.result = renderFunction();
    return this.result;
  }

  rerender() {
    if (!this.renderFunction) throw new Error("hook has not been rendered");
    return this.render(this.renderFunction);
  }

  useRef(initial: unknown) {
    const slot = this.take("ref", { current: initial });
    return slot.value;
  }

  useState(initial: unknown) {
    const slot = this.take("state", typeof initial === "function" ? (initial as () => unknown)() : initial);
    const setState = (next: unknown) => {
      slot.value = typeof next === "function"
        ? (next as (value: unknown) => unknown)(slot.value)
        : next;
    };
    return [slot.value, setState] as const;
  }

  useMemo(factory: () => unknown, deps: readonly unknown[] | undefined) {
    const slot = this.take("memo", undefined);
    if (!slot.deps || !sameDeps(slot.deps, deps)) {
      slot.value = factory();
      slot.deps = deps;
    }
    return slot.value;
  }

  useCallback(factory: unknown, deps: readonly unknown[] | undefined) {
    return this.useMemo(() => factory, deps);
  }

  useEffect(effect: () => void | (() => void), deps: readonly unknown[] | undefined) {
    const slot = this.take("effect", undefined);
    if (!slot.deps || !sameDeps(slot.deps, deps)) {
      slot.cleanup?.();
      const cleanup = effect();
      slot.cleanup = typeof cleanup === "function" ? cleanup : undefined;
      slot.deps = deps;
    }
  }

  cleanup() {
    for (const slot of this.slots) slot.cleanup?.();
    this.slots = [];
  }

  private take(kind: string, initial: unknown) {
    const current = this.slots[this.cursor];
    if (current && current.kind !== kind) throw new Error(`hook order changed: ${current.kind} -> ${kind}`);
    const slot = current ?? { kind, value: initial };
    this.slots[this.cursor] = slot;
    this.cursor += 1;
    return slot;
  }
}

function sameDeps(left: readonly unknown[], right: readonly unknown[] | undefined) {
  if (!right || left.length !== right.length) return false;
  return left.every((value, index) => Object.is(value, right[index]));
}

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

describe("useCompanionSession voice persistence boundary", () => {
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
  });

  afterEach(() => mocks.hook.cleanup());

  it("完整语音回复要等播放 drained 才落库并启动记忆；中断只留 interrupted", async () => {
    const render = () => useCompanionSession();
    const harness = mocks.hook as HookHarness;
    let session = harness.render(render);
    await flushMicrotasks();
    session = harness.rerender();

    const firstController = new AbortController();
    const firstRequest: VoiceTurnRequest = { turnId: 1, signal: firstController.signal };
    const firstSend = session.send("第一轮", "voice", undefined, firstRequest);
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
    expect(completed?.completion).toBeUndefined();
    expect(completed?.playbackStatus).toBe("played");
    expect(mocks.extractor.extract).toHaveBeenCalledTimes(1);

    const secondController = new AbortController();
    const secondRequest: VoiceTurnRequest = { turnId: 2, signal: secondController.signal };
    const secondSend = session.send("第二轮", "voice", undefined, secondRequest);
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
    await expect(firstSend).resolves.toEqual(providerReply);
    await flushMicrotasks();

    session = harness.rerender();
    expect(session.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "assistant", source: "text", content: providerReply.japaneseText }),
    ]));
    expect(mocks.storage.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "assistant", source: "text", content: providerReply.japaneseText }),
    ]));
    expect(mocks.streamChat.mock.calls[0][5]).toBeUndefined();

    const secondSend = session.send("第二轮文本", "text");
    const secondStream = mocks.currentStream as { resolve: (reply: CompanionReply) => void };
    secondStream.resolve(providerReply);
    await expect(secondSend).resolves.toEqual(providerReply);
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
    const recoveryStream = mocks.currentStream as { resolve: (reply: CompanionReply) => void };
    recoveryStream.resolve(providerReply);
    await expect(recoverySend).resolves.toEqual(providerReply);
    await flushMicrotasks();

    expect(mocks.storage.rows.filter((message: ChatMessage) => (
      message.role === "assistant" && !message.error
    ))).toHaveLength(1);
  });
});
