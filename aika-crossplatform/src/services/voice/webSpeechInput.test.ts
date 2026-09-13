import { afterEach, describe, expect, it, vi } from "vitest";
import { createWebSpeechInputEngine } from "./webSpeechInput";
import { createVoicePresenter } from "../../presentation/voicePresenter";

class FakeRecognition {
  static current: FakeRecognition | null = null;
  lang = "";
  continuous = false;
  interimResults = false;
  flushOnStop = false;
  onstart: (() => void) | null = null;
  onspeechstart: (() => void) | null = null;
  onresult: ((event: any) => void) | null = null;
  onerror: ((event: any) => void) | null = null;
  onend: (() => void) | null = null;

  constructor() {
    FakeRecognition.current = this;
  }

  start() {
    this.onstart?.();
  }

  stop() {
    if (this.flushOnStop) this.emit([{ isFinal: true, transcript: "" }]);
    this.onend?.();
  }

  abort() {
    this.onend?.();
  }

  emit(results: Array<{ isFinal: boolean; transcript: string }>) {
    this.onresult?.({
      resultIndex: 0,
      results: results.map((result) => ({ isFinal: result.isFinal, 0: { transcript: result.transcript } })),
    });
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("createWebSpeechInputEngine", () => {
  it("同一次回调含上一段 final 和下一段 interim 时，先交付 final 再显示新文字", () => {
    vi.stubGlobal("window", { SpeechRecognition: FakeRecognition });
    const engine = createWebSpeechInputEngine();
    const events: string[] = [];
    engine.start("ja-JP", {
      onFinal: (result) => events.push(`final:${result.text}`),
      onInterim: (text) => events.push(`interim:${text}`),
    });
    FakeRecognition.current!.emit([
      { isFinal: true, transcript: "今日は。" },
      { isFinal: false, transcript: "まあ" },
    ]);
    expect(events).toEqual(["final:今日は。", "interim:まあ"]);
  });

  it("三轮后第四轮只有 interim 就结束：保留文字并提示，重说后可继续提交", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"] });
    vi.stubGlobal("window", { SpeechRecognition: FakeRecognition });
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) } });
    const engine = createWebSpeechInputEngine();
    const onTranscript = vi.fn(async (_text: string) => ({ japaneseText: "はい。", chineseTranslation: "", mood: "neutral" as const }));
    const presenter = createVoicePresenter({
      createInputEngine: async () => ({ engine, note: "test", degraded: false }),
      outputEngine: { id: "fake", kind: "web-speech", isAvailable: () => true, speak: (_request, events) => { events?.onStart?.(); events?.onEnd?.(); }, stop: () => undefined },
      createMonitor: () => ({ isAvailable: () => true, start: async () => undefined, stop: () => undefined, dispose: async () => undefined }),
    });
    presenter.configure({ onTranscript, resolveLanguage: () => "ja-JP" });
    try {
      await presenter.open();
      // 系统 stop 可能补送一个已被 Presenter epoch 丢弃的 final，消耗序号。
      FakeRecognition.current!.flushOnStop = true;
      for (let index = 0; index < 3; index += 1) {
        FakeRecognition.current!.emit([{ isFinal: true, transcript: `第${index}句。` }]);
        await vi.advanceTimersByTimeAsync(1500);
      }
      expect(onTranscript).toHaveBeenCalledTimes(3);
      FakeRecognition.current!.emit([{ isFinal: true, transcript: "それで、" }]);
      FakeRecognition.current!.onend?.();
      await vi.advanceTimersByTimeAsync(200);
      FakeRecognition.current!.emit([{ isFinal: false, transcript: "まあ" }]);
      FakeRecognition.current!.onend?.();
      await vi.advanceTimersByTimeAsync(5000);
      expect(presenter.getSnapshot().interim).toBe("まあ");
      expect(presenter.getSnapshot().error).toContain("未能确认");
      expect(onTranscript).toHaveBeenCalledTimes(3);
      FakeRecognition.current!.emit([{ isFinal: false, transcript: "もう一度" }]);
      expect(presenter.getSnapshot().error).toBe("");
      FakeRecognition.current!.emit([{ isFinal: true, transcript: "もう一度話します。" }]);
      await vi.advanceTimersByTimeAsync(1500);
      expect(onTranscript).toHaveBeenCalledTimes(4);
      expect(onTranscript.mock.calls[3][0]).toBe("それで、もう一度話します。");
      expect(presenter.getSnapshot().interim).toBe("");
    } finally {
      presenter.dispose();
    }
  });

  it("下一段已开口但文字未返回时，不把前一段提交；说完后合并为一轮", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"] });
    vi.stubGlobal("window", { SpeechRecognition: FakeRecognition });
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) } });
    const engine = createWebSpeechInputEngine();
    const onTranscript = vi.fn(async (_text: string) => null);
    const presenter = createVoicePresenter({
      createInputEngine: async () => ({ engine, note: "test", degraded: false }),
      outputEngine: { id: "fake", kind: "web-speech", isAvailable: () => true, speak: () => undefined, stop: () => undefined },
      createMonitor: () => ({ isAvailable: () => true, start: async () => undefined, stop: () => undefined, dispose: async () => undefined }),
    });
    presenter.configure({ onTranscript, resolveLanguage: () => "ja-JP" });
    try {
      await presenter.open();
      FakeRecognition.current!.emit([{ isFinal: true, transcript: "今は。" }]);
      FakeRecognition.current!.onend?.();
      await vi.advanceTimersByTimeAsync(200);
      FakeRecognition.current!.onspeechstart?.();
      await vi.advanceTimersByTimeAsync(2500);
      expect(onTranscript).not.toHaveBeenCalled();
      expect(presenter.getSnapshot().pending).toBe("今は。");
      FakeRecognition.current!.emit([{ isFinal: true, transcript: "まだ話しています。" }]);
      await vi.advanceTimersByTimeAsync(1300);
      expect(onTranscript).toHaveBeenCalledTimes(1);
      expect(onTranscript.mock.calls[0]?.[0]).toBe("今は。まだ話しています。");
    } finally {
      presenter.dispose();
    }
  });

  it("文字之前报告开口，并在没有识别结果而结束时释放该段", () => {
    vi.stubGlobal("window", { SpeechRecognition: FakeRecognition });
    const engine = createWebSpeechInputEngine();
    const onSpeechStart = vi.fn();
    const onFinal = vi.fn();
    engine.start("ja-JP", { onSpeechStart, onFinal });
    FakeRecognition.current!.onspeechstart?.();
    expect(onSpeechStart).toHaveBeenCalledTimes(1);
    FakeRecognition.current!.onend?.();
    expect(onFinal).toHaveBeenCalledWith(expect.objectContaining({ text: "", segmentId: onSpeechStart.mock.calls[0][0].segmentId }));
  });

  it("给每个片段补齐 sequence、估算时间和 final 边界", () => {
    vi.stubGlobal("window", { SpeechRecognition: FakeRecognition });
    const engine = createWebSpeechInputEngine();
    const starts: any[] = [];
    const ends: any[] = [];
    const finals: any[] = [];

    engine.start("ja-JP", {
      onSpeechStart: (event) => starts.push(event),
      onSegmentEnd: (event) => ends.push(event),
      onFinal: (result) => finals.push(result),
    });
    FakeRecognition.current!.emit([{ isFinal: false, transcript: "今日は" }]);
    FakeRecognition.current!.emit([{ isFinal: true, transcript: "今日は疲れた。" }]);

    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(finals).toHaveLength(1);
    expect(finals[0].text).toBe("今日は疲れた。");
    expect(finals[0].segmentId).toBe(starts[0].segmentId);
    expect(finals[0].sequence).toBe(0);
    expect(finals[0].timeSource).toBe("estimated");
    expect(finals[0].audioEndAt).toBeGreaterThanOrEqual(finals[0].audioStartAt);
  });

  it("onend 没有 final 时也释放 ASR 在途状态，但文本为空", () => {
    vi.stubGlobal("window", { SpeechRecognition: FakeRecognition });
    const engine = createWebSpeechInputEngine();
    const finals: string[] = [];
    let ends = 0;

    engine.start("en-US", {
      onSegmentEnd: () => { ends += 1; },
      onFinal: (result) => finals.push(result.text),
    });
    FakeRecognition.current!.emit([{ isFinal: false, transcript: "I was" }]);
    engine.stop();

    expect(ends).toBe(1);
    expect(finals).toEqual([""]);
  });
});
