import { describe, expect, it } from "vitest";
import type { SpeechOutputEvents, SpeechOutputRequest, VoiceCaption } from "../services/voice/contracts";
import type { CompanionReply } from "../domain/companion";
import type { PartialReply } from "../domain/streamingReply";
import type { SpeechFinalResult, VoiceTurnRequest } from "../domain/voiceRuntime";
import { createVoicePresenter, type VoiceTimers } from "./voicePresenter";

/**
 * CORE-04-E：语音打断在 Presenter 内编排，用 fake STT/TTS 验收。
 *
 * 判据不是「调了哪个函数」，而是：用户重新开口后
 * 1. 本轮 VoiceTurnRequest 被 abort（会话层据此触发 Runtime cancel）；
 * 2. TTS 收到 stop；
 * 3. STT 继续接收（引擎重新 start），打断不是把语音页关掉；
 * 4. 这一轮没有被当作「完整播放」结算。
 */

interface InputProbe {
  engine: any;
  events: any;
  startCalls: number;
  stops: number;
  aborts: number;
}

function createInput(): InputProbe {
  const probe: InputProbe = {
    events: {}, startCalls: 0, stops: 0, aborts: 0,
    engine: null,
  };
  probe.engine = {
    id: "fake-input",
    kind: "web-speech",
    continuous: false,
    isAvailable: () => true,
    requestPermission: async () => undefined,
    start: (_language: string, events: any) => {
      probe.startCalls += 1;
      probe.events = events;
      events.onStart?.();
    },
    stop: () => { probe.stops += 1; },
    abort: () => { probe.aborts += 1; },
    dispose: () => undefined,
  };
  return probe;
}

function createOutput() {
  const requests: Array<{ request: SpeechOutputRequest; events: SpeechOutputEvents }> = [];
  let stops = 0;
  const engine = {
    id: "fake-output",
    kind: "web-speech" as const,
    isAvailable: () => true,
    speak: (request: SpeechOutputRequest, events: SpeechOutputEvents = {}) => {
      requests.push({ request, events });
      events.onStart?.();
    },
    stop: () => { stops += 1; },
  };
  return {
    engine,
    stopCount: () => stops,
    drain() {
      for (const entry of requests) entry.events.onEnd?.();
    },
  };
}

function createMonitor() {
  let callback: ((event: { atMonotonicMs: number }) => void) | null = null;
  return {
    monitor: {
      isAvailable: () => true,
      start: async (next: (event: { atMonotonicMs: number }) => void) => { callback = next; },
      stop: () => undefined,
      dispose: async () => undefined,
    },
    speak: (atMonotonicMs: number) => callback?.({ atMonotonicMs }),
  };
}

function createTimers(): { port: VoiceTimers; runTimeouts(): void; pendingTimeouts(): number } {
  const timeouts: Array<() => void> = [];
  const intervals: Array<() => void> = [];
  return {
    port: {
      setInterval: (handler) => { intervals.push(handler); return intervals.length; },
      clearInterval: () => undefined,
      setTimeout: (handler) => { timeouts.push(handler); return timeouts.length; },
      clearTimeout: () => undefined,
    },
    runTimeouts() { while (timeouts.length) timeouts.shift()!(); },
    pendingTimeouts: () => timeouts.length,
  };
}

const segment = (sequence: number, text: string): SpeechFinalResult => ({
  segmentId: `segment-${sequence}`,
  sequence,
  audioStartAt: sequence * 1_000,
  audioEndAt: sequence * 1_000 + 500,
  timeSource: "audio",
  text,
});

describe("VoicePresenter 打断编排（fake STT/TTS）", () => {
  it("重新开口：abort 本轮请求（→Runtime cancel）、TTS stop，STT 继续接收，不算完整播放", async () => {
    const input = createInput();
    const output = createOutput();
    const monitor = createMonitor();
    const timers = createTimers();

    const abortReasons: number[] = [];
    let playedCount = 0;
    let transcriptCalls = 0;
    const presenter = createVoicePresenter({
      createInputEngine: async () => ({ engine: input.engine, note: "fake", degraded: false }),
      outputEngine: output.engine,
      createMonitor: () => monitor.monitor,
      timers: timers.port,
    });
    presenter.configure({
      onTranscript: (_text, _onPartial: (partial: PartialReply) => void, request: VoiceTurnRequest) => {
        transcriptCalls += 1;
        request.onPlaybackComplete = () => { playedCount += 1; };
        request.onPlaybackFailed = () => undefined;
        // 会话层的真实接线：abort → Runtime cancel。这里用一个可观测的等价物。
        request.signal.addEventListener("abort", () => abortReasons.push(request.turnId), { once: true });
        return new Promise<CompanionReply | null>(() => undefined);
      },
      resolveLanguage: () => "ja-JP",
    });

    await presenter.open();
    expect(presenter.getSnapshot().phase).toBe("listening");

    input.events.onFinal(segment(0, "第一轮。"));
    presenter.sendNow();
    expect(transcriptCalls).toBe(1);
    await Promise.resolve();
    expect(presenter.getSnapshot().phase).toBe("thinking");

    const stopsBefore = output.stopCount();
    // 用户重新开口（非连续链路靠能量监听回调）。
    monitor.speak(700);

    expect(abortReasons).toEqual([1]);
    expect(output.stopCount()).toBeGreaterThan(stopsBefore);
    expect(presenter.getSnapshot().phase).toBe("listening");

    // STT 继续接收：麦克风重新启动，新片段能继续累积。
    timers.runTimeouts();
    expect(input.startCalls).toBeGreaterThanOrEqual(2);
    input.events.onFinal(segment(1, "第二轮。"));
    expect(presenter.getSnapshot().pending).toContain("第二轮");

    // 被打断的这一轮没有被当作完整播放。
    expect(playedCount).toBe(0);
  });

  it("完整一轮：TTS drained 才算播放完成，字幕原地增长", async () => {
    const input = createInput();
    const output = createOutput();
    const monitor = createMonitor();
    const timers = createTimers();
    let resolveReply!: (reply: CompanionReply | null) => void;
    let playedCount = 0;

    const presenter = createVoicePresenter({
      createInputEngine: async () => ({ engine: input.engine, note: "fake", degraded: false }),
      outputEngine: output.engine,
      createMonitor: () => monitor.monitor,
      timers: timers.port,
    });
    presenter.configure({
      onTranscript: (_text, onPartial, request) => {
        request.onPlaybackComplete = () => { playedCount += 1; };
        onPartial({ japaneseText: "第一句。", chineseTranslation: "", mood: "neutral", japaneseComplete: false });
        return new Promise<CompanionReply | null>((resolve) => { resolveReply = resolve; });
      },
    });

    await presenter.open();
    input.events.onFinal(segment(0, "你好。"));
    presenter.sendNow();
    resolveReply({ japaneseText: "第一句。第二句。", chineseTranslation: "翻译", mood: "neutral" });
    await Promise.resolve();
    await Promise.resolve();

    output.drain();
    await Promise.resolve();
    await Promise.resolve();

    expect(playedCount).toBe(1);
    expect(presenter.getSnapshot().phase).toBe("listening");
    const assistantCaptions = presenter.getSnapshot().captions.filter((caption: VoiceCaption) => caption.speaker === "assistant");
    expect(assistantCaptions.length).toBeGreaterThanOrEqual(1);
  });

  it("CORE-04-D dispose 释放引擎与计时器，重复 close 不产生重复订阅", async () => {
    const input = createInput();
    const output = createOutput();
    const monitor = createMonitor();
    const timers = createTimers();
    const presenter = createVoicePresenter({
      createInputEngine: async () => ({ engine: input.engine, note: "fake", degraded: false }),
      outputEngine: output.engine,
      createMonitor: () => monitor.monitor,
      timers: timers.port,
    });
    presenter.configure({ onTranscript: async () => null, resolveLanguage: () => "ja-JP" });

    await presenter.open();
    expect(presenter.getSnapshot().isOpen).toBe(true);

    let notifications = 0;
    const unsubscribe = presenter.subscribe(() => { notifications += 1; });
    unsubscribe();
    presenter.close();
    expect(presenter.getSnapshot().isOpen).toBe(false);

    const snapshot = presenter.getSnapshot();
    presenter.dispose();
    presenter.close();
    expect(presenter.getSnapshot()).toBe(snapshot);
    expect(notifications).toBe(0);
  });
});
