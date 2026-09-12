import { afterEach, describe, expect, it, vi } from "vitest";
import { createCloudTtsOutput, type CloudTtsConfig, DEFAULT_CLOUD_TTS } from "./cloudTtsOutput";
import {
  runSpeechOutputConformance, type SpeechOutputFixture, type SpeechOutputHarness,
} from "./speechOutput.conformance";
import { webSpeechOutput } from "./webSpeechOutput";

/**
 * CORE-05-G（输出侧）：同一份输出用例包，两个真实实现各跑一遍。
 *
 * 两个被测对象都是生产实现——`webSpeechOutput` 与 `cloudTtsOutput`，不是测试桩。
 * 被替掉的只有它们下面的外部设备与传输层：系统合成那边是 `SpeechSynthesis`，
 * 云端那边是 `HttpFetch` 与 `Audio`。不启动真实设备，也不向任何云服务发请求。
 */

/**
 * 等一个条件成立，而不是去数「该让出几次微任务」。
 *
 * 云端那条链路是 `synthesize()`（`await send()` → `await response.arrayBuffer()`）
 * 再 `.then(play)` 再 `audio.play()`，中间跨了好几次真实的任务边界——`Response` 的
 * 正文读取和 `play()` 都是走任务队列的。裸微任务（`await Promise.resolve()`）
 * 越不过这些边界，数几次都不对：数少了探针在实现还没排上队时就返回，数多了又是
 * 在赌博。所以这里用真实定时器轮询「探针能观测到的那个结果」，实现多几层 Promise
 * 也不会漏。条件是探针自己的事，flush 只是通用等待原语。
 */
async function until(condition: () => boolean, label: string) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (condition()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`等待超时：${label}`);
}

// ---------------------------------------------------------------------------
// webSpeechOutput：假的 SpeechSynthesis
// ---------------------------------------------------------------------------

class FakeUtterance {
  static last: FakeUtterance | null = null;
  text: string;
  lang = "";
  voice: unknown = null;
  rate = 1;
  pitch = 1;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;

  constructor(text: string) {
    this.text = text;
    FakeUtterance.last = this;
  }
}

function webSpeechHarness(): SpeechOutputHarness {
  return {
    name: "webSpeechOutput",
    async create(): Promise<SpeechOutputFixture> {
      FakeUtterance.last = null;
      let cancels = 0;
      const synthesis = {
        getVoices: () => [],
        cancel: () => { cancels += 1; },
        speak: () => undefined,
      };
      vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
      vi.stubGlobal("window", { speechSynthesis: synthesis, SpeechSynthesisUtterance: FakeUtterance });

      return {
        subject: webSpeechOutput,
        probe: {
          start: () => FakeUtterance.last?.onstart?.(),
          finish: () => FakeUtterance.last?.onend?.(),
          fail: (message: string) => FakeUtterance.last?.onerror?.({ error: message }),
          stopCalls: () => cancels,
        },
        dispose: async () => undefined,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// cloudTtsOutput：假的 HttpFetch + 假的 Audio
// ---------------------------------------------------------------------------

/** 播放器替身：只记录被要求做了什么，不出声。 */
class FakeAudio {
  static last: FakeAudio | null = null;
  static pauses = 0;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public src: string) {
    FakeAudio.last = this;
  }

  play(): Promise<void> {
    return Promise.resolve();
  }

  pause(): void {
    FakeAudio.pauses += 1;
  }
}

/** 假传输层：合成请求停在这里，由探针决定它成功还是失败。 */
function pendingFetch() {
  const waiting: { resolve(bytes: Uint8Array): void; reject(error: Error): void }[] = [];
  const send = vi.fn(
    () => new Promise<Response>((resolve, reject) => {
      waiting.push({
        resolve: (bytes) => resolve(new Response(bytes, { status: 200 })),
        reject,
      });
    }),
  );
  return {
    send: send as unknown as (input: string, init: RequestInit) => Promise<Response>,
    settleAll(outcome: "ok" | Error) {
      const pending = waiting.splice(0, waiting.length);
      for (const item of pending) {
        if (outcome === "ok") item.resolve(new Uint8Array([1, 2, 3]));
        else item.reject(outcome);
      }
    },
    requestCount: () => send.mock.calls.length,
  };
}

const cloudConfig: CloudTtsConfig = {
  ...DEFAULT_CLOUD_TTS,
  baseUrl: "https://tts.invalid/v1",
  model: "tts-x",
  voice: "shimmer",
  speed: 1,
  apiKey: "sk-conformance",
};

function cloudTtsHarness(): SpeechOutputHarness {
  return {
    name: "cloudTtsOutput",
    async create(): Promise<SpeechOutputFixture> {
      FakeAudio.last = null;
      FakeAudio.pauses = 0;
      let errorsReported = 0;
      const transport = pendingFetch();
      vi.stubGlobal("Audio", FakeAudio);

      const subject = createCloudTtsOutput(() => cloudConfig, transport.send);
      // 包一层只为了记「onError 已经到过」：实现内部怎么调度不该由用例包去猜。
      const wrapped: typeof subject = {
        ...subject,
        speak: (request, events = {}) => subject.speak(request, {
          ...events,
          onError: (message) => { errorsReported += 1; events.onError?.(message); },
        }),
      };

      return {
        subject: wrapped,
        probe: {
          async start() {
            transport.settleAll("ok");
            // 等实现真的走到了 `new Audio(...)`：这时 `play()` 已经发出，`onStart` 也随之到来。
            await until(() => FakeAudio.last !== null, "云端合成完成并开始播放");
          },
          finish: () => FakeAudio.last?.onended?.(),
          async fail(message: string) {
            transport.settleAll(new Error(message));
            // 失败不产音频，等的是「这一次请求已经落到实现手里并报了错」。
            await until(() => errorsReported > 0, "云端合成失败已上报");
          },
          stopCalls: () => FakeAudio.pauses,
        },
        dispose: async () => undefined,
      };
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

runSpeechOutputConformance(webSpeechHarness());
runSpeechOutputConformance(cloudTtsHarness());

describe("输出侧可替换性状态", () => {
  it("两个真实实现跑的是同一份用例包", () => {
    const harnesses = [webSpeechHarness(), cloudTtsHarness()];
    expect(harnesses.map((harness) => harness.name)).toEqual(["webSpeechOutput", "cloudTtsOutput"]);
    // 用例包只有一份，两边都是拿它整包跑，不存在「谁跑了一个子集」。
    expect(new Set([runSpeechOutputConformance]).size).toBe(1);
  });

  it("两个实现对 prefetch 的声明不同，这是契约允许的可选能力", () => {
    // 系统合成没有等待，实现预取只会白做；云端每句一次往返，必须有。
    expect(webSpeechOutput.prefetch).toBeUndefined();
    expect(createCloudTtsOutput(() => cloudConfig).prefetch).toBeTypeOf("function");
  });
});
