import { afterEach, describe, expect, it, vi } from "vitest";
import { createWebSpeechInputEngine } from "./webSpeechInput";

class FakeRecognition {
  static current: FakeRecognition | null = null;
  lang = "";
  continuous = false;
  interimResults = false;
  onstart: (() => void) | null = null;
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

afterEach(() => vi.unstubAllGlobals());

describe("createWebSpeechInputEngine", () => {
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
