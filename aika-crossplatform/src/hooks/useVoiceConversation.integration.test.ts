import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompanionReply } from "../domain/companion";
import type { PartialReply } from "../domain/streamingReply";
import type { VoiceTurnRequest } from "../domain/voiceRuntime";

/**
 * 这是一个最小 Hook harness，不是第二套语音算法：下面的测试直接运行
 * useVoiceConversation，输入事件、SpeechQueue、取消链和回合埋点都走生产代码。
 * React DOM 不在 Vitest 的 node 环境里，因此只替换 React 的状态容器。
 */
class HookHarness {
  private slots: Array<{ kind: string; value: unknown; deps?: readonly unknown[]; cleanup?: () => void }> = [];
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
    return slot.value as { current: unknown };
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
    this.result = undefined;
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
    inputEvents: null,
    monitorCallback: null,
    outputRequests: [],
    outputStops: 0,
    createInputEngine: vi.fn(),
  };

  state.input = {
    id: "integration-input",
    kind: "web-speech",
    continuous: false,
    isAvailable: () => true,
    requestPermission: async () => undefined,
    start: (_language: string, events: unknown) => {
      state.inputEvents = events;
      (events as any).onStart?.();
    },
    stop: () => undefined,
    abort: () => undefined,
    dispose: () => undefined,
  };
  state.createInputEngine.mockImplementation(async () => ({ engine: state.input, note: "integration fake", degraded: false }));

  state.output = {
    id: "integration-output",
    kind: "web-speech",
    isAvailable: () => true,
    speak: (request: unknown, events: unknown = {}) => {
      const entry = { request, events };
      state.outputRequests.push(entry);
      (events as any).onStart?.();
    },
    stop: () => { state.outputStops += 1; },
  };
  return state;
});

vi.mock("react", () => ({
  useRef: (initial: unknown) => mocks.hook.useRef(initial),
  useState: (initial: unknown) => mocks.hook.useState(initial),
  useMemo: (factory: () => unknown, deps: readonly unknown[]) => mocks.hook.useMemo(factory, deps),
  useCallback: (factory: unknown, deps: readonly unknown[]) => mocks.hook.useCallback(factory, deps),
  useEffect: (effect: () => void | (() => void), deps: readonly unknown[]) => mocks.hook.useEffect(effect, deps),
}));

vi.mock("../services/voice/inputEngine", () => ({
  DEFAULT_VOICE_BACKEND: { backend: "web-speech", whisperEndpoint: "http://127.0.0.1:8080" },
  createInputEngine: (...args: unknown[]) => mocks.createInputEngine(...args),
}));

vi.mock("../services/voice/webSpeechOutput", () => ({ webSpeechOutput: mocks.output }));

vi.mock("../services/voice/micActivity", () => ({
  createMicActivityMonitor: () => ({
    isAvailable: () => true,
    start: async (callback: unknown) => { mocks.monitorCallback = callback; },
    stop: () => undefined,
    dispose: async () => undefined,
  }),
}));

import { useVoiceConversation } from "./useVoiceConversation";

interface FakeStorage {
  records: string[];
  pendingWrites: Promise<void>[];
}

interface FakeProvider {
  request: VoiceTurnRequest | null;
  resolve(reply: CompanionReply): void;
  partial(partial: PartialReply): void;
}

function createFakeProvider(storage: FakeStorage): { handler: (text: string, onPartial: (partial: PartialReply) => void, request: VoiceTurnRequest) => Promise<CompanionReply>; provider: FakeProvider } {
  let current: { resolve: (reply: CompanionReply) => void; onPartial: (partial: PartialReply) => void } | null = null;
  const provider: FakeProvider = {
    request: null,
    resolve(reply) {
      current?.resolve(reply);
    },
    partial(partial) {
      current?.onPartial(partial);
    },
  };
  return {
    provider,
    handler: async (text, onPartial, request) => new Promise((resolve) => {
      provider.request = request;
      storage.records.push(`asked:${text}`);
      current = { resolve: (reply) => { storage.records.push("provider:resolved"); resolve(reply); }, onPartial };
      request.onPlaybackComplete = () => storage.records.push("assistant:played");
      request.onPlaybackFailed = () => storage.records.push("assistant:not-played");
      request.signal.addEventListener("abort", () => {
        if (!storage.records.includes("assistant:played")) storage.records.push("assistant:interrupted");
      }, { once: true });
    }),
  };
}

function segment(sequence: number, endAt: number) {
  return {
    segmentId: `segment-${sequence}`,
    sequence,
    audioStartAt: endAt - 300,
    audioEndAt: endAt,
    timeSource: "audio" as const,
  };
}

function reply(text = "第一句。第二句。" ): CompanionReply {
  return { japaneseText: text, chineseTranslation: "翻译", mood: "neutral" };
}

function finishAllOutput() {
  let cursor = 0;
  while (cursor < mocks.outputRequests.length) {
    const entry = mocks.outputRequests[cursor];
    (entry.events as any).onEnd?.();
    cursor += 1;
  }
}

async function flushMicrotasks() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

describe("useVoiceConversation S1 orchestration", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.hook = new HookHarness();
    mocks.inputEvents = null;
    mocks.monitorCallback = null;
    mocks.outputRequests.length = 0;
    mocks.outputStops = 0;
    mocks.createInputEngine.mockClear();
    vi.stubGlobal("window", {
      setInterval,
      clearInterval,
      setTimeout,
      clearTimeout,
    });
  });

  afterEach(() => {
    mocks.hook.cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("乱序 ASR 在途未清空前不提交，清空后只提交一次且 segment 可追溯到 turn", async () => {
    const storage: FakeStorage = { records: [], pendingWrites: [] };
    const fake = createFakeProvider(storage);
    const telemetry: any[] = [];
    const render = () => useVoiceConversation(fake.handler, () => "ja-JP", undefined, (event) => telemetry.push(event));
    const harness = mocks.hook as HookHarness;
    let voice = harness.render(render);
    await voice.open();
    voice = harness.rerender();

    voice.sendNow();
    expect(fake.provider.request).toBeNull();

    mocks.inputEvents.onSpeechStart({ segmentId: "segment-0", sequence: 0, audioStartAt: 100, timeSource: "audio" });
    mocks.inputEvents.onSpeechStart({ segmentId: "segment-1", sequence: 1, audioStartAt: 400, timeSource: "audio" });
    mocks.inputEvents.onSegmentEnd(segment(0, 300));
    mocks.inputEvents.onSegmentEnd(segment(1, 600));
    mocks.inputEvents.onFinal({ ...segment(1, 600), text: "世界。" });
    voice.sendNow();
    expect(fake.provider.request).toBeNull();

    mocks.inputEvents.onFinal({ ...segment(0, 300), text: "你好。" });
    voice = harness.rerender();
    voice.sendNow();
    voice.sendNow();
    expect(fake.provider.request).not.toBeNull();
    expect(storage.records.filter((record) => record.startsWith("asked:")).length).toBe(1);

    const committed = telemetry.find((event) => event.name === "turnCommitted");
    expect(committed).toBeDefined();
    expect(telemetry.filter((event) => event.name === "speechEnd").map((event) => event.turnId)).toEqual([committed.turnId, committed.turnId]);
    expect(telemetry.filter((event) => event.name === "asrFinal").map((event) => event.turnId)).toEqual([committed.turnId, committed.turnId]);
    expect(voice.diagnostics.snapshot().events.some((event: any) => event.name === "turnCommitted")).toBe(true);

    fake.provider.partial({ japaneseText: "第一句。", chineseTranslation: "", mood: "neutral", japaneseComplete: false });
    fake.provider.resolve(reply());
    await flushMicrotasks();
    finishAllOutput();
    await flushMicrotasks();
    expect(storage.records).toContain("assistant:played");
  });

  it("生成结束但播放未 drained 时取消：旧轮不收尾，新轮可以成功", async () => {
    const storage: FakeStorage = { records: [], pendingWrites: [] };
    const fake = createFakeProvider(storage);
    const render = () => useVoiceConversation(fake.handler, () => "ja-JP");
    const harness = mocks.hook as HookHarness;
    let voice = harness.render(render);
    await voice.open();
    voice = harness.rerender();

    mocks.inputEvents.onFinal({ ...segment(0, 300), text: "第一轮。" });
    voice = harness.rerender();
    voice.sendNow();
    fake.provider.resolve(reply());
    await Promise.resolve();
    await Promise.resolve();
    expect(storage.records).not.toContain("assistant:played");

    voice.interruptAndListen("button", 500);
    voice.interruptAndListen("button", 510);
    expect(fake.provider.request?.signal.aborted).toBe(true);
    expect(storage.records).toContain("assistant:interrupted");

    vi.advanceTimersByTime(160);
    voice = harness.rerender();
    mocks.inputEvents.onFinal({ ...segment(1, 900), text: "第二轮。" });
    voice = harness.rerender();
    voice.sendNow();
    fake.provider.resolve(reply("新的回复。"));
    await flushMicrotasks();
    finishAllOutput();
    await flushMicrotasks();
    expect(storage.records.filter((record) => record === "assistant:played")).toHaveLength(1);
    expect(mocks.outputStops).toBeGreaterThanOrEqual(2);
  });

  it("Web Speech 生成阶段就开始监听打断，检测回调使用单调时间并淘汰旧 epoch", async () => {
    const storage: FakeStorage = { records: [], pendingWrites: [] };
    const fake = createFakeProvider(storage);
    const telemetry: any[] = [];
    const render = () => useVoiceConversation(fake.handler, () => "ja-JP", undefined, (event) => telemetry.push(event));
    const harness = mocks.hook as HookHarness;
    let voice = harness.render(render);
    await voice.open();
    voice = harness.rerender();

    mocks.inputEvents.onFinal({ ...segment(0, 300), text: "生成中打断。" });
    voice = harness.rerender();
    voice.sendNow();
    expect(mocks.monitorCallback).not.toBeNull();
    const firstRequest = fake.provider.request;
    fake.provider.partial({ japaneseText: "第一句。", chineseTranslation: "", mood: "neutral", japaneseComplete: false });
    (mocks.monitorCallback as (event: { atMonotonicMs: number }) => void)({ atMonotonicMs: 700 });
    expect(firstRequest?.signal.aborted).toBe(true);
    expect(telemetry.find((event) => event.name === "interruptDetected")).toMatchObject({ turnId: 1 });
    expect(telemetry.find((event) => event.name === "playbackStopped")).toMatchObject({
      turnId: 1,
      details: { status: "stopRequested", precision: "proxy" },
    });

    // 旧 Web Speech 回调不应清空新轮或污染新轮文本；新输入从新 epoch 开始。
    vi.advanceTimersByTime(160);
    voice = harness.rerender();
    mocks.inputEvents.onFinal({ ...segment(1, 900), text: "新轮。" });
    voice = harness.rerender();
    voice.sendNow();
    expect(storage.records.filter((record) => record.startsWith("asked:")).length).toBe(2);
  });
});
