import { afterEach, describe, expect, it, vi } from "vitest";
import { createWhisperInputEngine } from "./whisperInput";
import { createWebSpeechInputEngine } from "./webSpeechInput";
import { runSpeechInputConformance, type SpeechInputFixture } from "./speechInput.conformance";

/**
 * CORE-05-G（输入侧）：两个真实输入引擎跑同一份用例包。
 *
 * - `webSpeechInput`：替换 `SpeechRecognition` 与事件回调，不碰真实麦克风。
 * - `whisperInput`：注入假采集 / 假 VAD 模型 / 假转写客户端；切段仍走真实的
 *   `domain/vadSegmenter`，因此这份用例验证的是引擎装配与事件契约，不是伪造切段。
 */

class FakeRecognition {
  static current: FakeRecognition | null = null;
  static stops = 0;
  lang = "";
  continuous = false;
  interimResults = false;
  onstart: (() => void) | null = null;
  onresult: ((event: unknown) => void) | null = null;
  onerror: ((event: { error: string; message?: string }) => void) | null = null;
  onend: (() => void) | null = null;

  constructor() {
    FakeRecognition.current = this;
  }

  start() { this.onstart?.(); }
  stop() { FakeRecognition.stops += 1; this.onend?.(); }
  abort() { this.onend?.(); }

  emit(results: Array<{ isFinal: boolean; transcript: string }>) {
    this.onresult?.({
      resultIndex: 0,
      results: results.map((result) => ({ isFinal: result.isFinal, 0: { transcript: result.transcript } })),
    });
  }
}

async function flush(times = 80): Promise<void> {
  for (let index = 0; index < times; index += 1) await Promise.resolve();
}

function webSpeechHarness() {
  return {
    name: "webSpeechInput",
    async create(): Promise<SpeechInputFixture> {
      vi.stubGlobal("window", { SpeechRecognition: FakeRecognition });
      FakeRecognition.current = null;
      FakeRecognition.stops = 0;
      const engine = createWebSpeechInputEngine();
      return {
        subject: engine,
        flush: () => flush(4),
        dispose: async () => { engine.dispose(); },
        probe: {
          async emitFinal(text: string) {
            // 同一段从 interim 更新为 final 是两次事件；结果列表不能把
            // interim 放在 final 前面（MDN SpeechRecognitionEvent.results）。
            FakeRecognition.current?.emit([{ isFinal: false, transcript: text.slice(0, 1) }]);
            FakeRecognition.current?.emit([{ isFinal: true, transcript: text }]);
          },
          emitInterim(text: string) {
            FakeRecognition.current?.emit([{ isFinal: false, transcript: text }]);
          },
          async emitError(code: string) {
            FakeRecognition.current?.onerror?.({ error: code });
          },
          stopCalls: () => FakeRecognition.stops,
        },
      };
    },
  };
}

function whisperHarness() {
  return {
    name: "whisperInput",
    unsupported: ["interim"] as const,
    async create(): Promise<SpeechInputFixture> {
      let events: { onFrame(frame: Float32Array, start: number, end: number): void } | null = null;
      let samplePos = 0;
      let stops = 0;
      let nextText = "";
      let failNext = false;
      const pending: number[] = [];

      const capture = {
        isAvailable: () => true,
        async start(next: { onFrame(frame: Float32Array, start: number, end: number): void }) {
          events = next;
        },
        stop() { stops += 1; },
        async dispose() { events = null; },
        read: (from: number, to: number) => new Float32Array(Math.max(0, to - from)),
        totalSamples: () => samplePos,
        sampleRate: () => 16_000,
        timeAtSample: (sample: number) => sample,
      };
      const vad = {
        async probability() { return pending.shift() ?? 0; },
        reset() { pending.length = 0; },
        async dispose() { pending.length = 0; },
      };
      const client = {
        async probe() { return true; },
        async transcribe() {
          if (failNext) {
            failNext = false;
            throw new Error("local asr is down");
          }
          return nextText;
        },
      };

      const engine = createWhisperInputEngine({
        endpoint: () => "http://127.0.0.1:8080",
        ports: { capture: () => capture, vad: () => vad, client: () => client },
      });

      function emitFrames(count: number, probability: number) {
        for (let index = 0; index < count; index += 1) {
          pending.push(probability);
          const start = samplePos;
          samplePos += 512;
          events?.onFrame(new Float32Array(512), start, samplePos);
        }
      }

      return {
        subject: engine,
        flush: () => flush(),
        dispose: async () => { engine.dispose(); },
        probe: {
          async emitFinal(text: string) {
            nextText = text;
            emitFrames(4, 0.9);   // 越过 minSpeechMs，触发 speech-start
            emitFrames(14, 0.1);  // 越过 silenceMs，触发 speech-end → 转写
            await flush();
          },
          async emitError() {
            failNext = true;
            nextText = "";
            emitFrames(4, 0.9);
            emitFrames(14, 0.1);
            await flush();
          },
          stopCalls: () => stops,
        },
      };
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

runSpeechInputConformance(webSpeechHarness());
runSpeechInputConformance(whisperHarness());

describe("语音输入实现的可替换性说明", () => {
  it("两个真实实现共用同一份用例包，且各自的 unsupported 声明不同", () => {
    const web = webSpeechHarness();
    const whisper = whisperHarness();
    expect(web.name).not.toBe(whisper.name);
    expect((whisper as { unsupported?: readonly string[] }).unsupported).toEqual(["interim"]);
  });
});
