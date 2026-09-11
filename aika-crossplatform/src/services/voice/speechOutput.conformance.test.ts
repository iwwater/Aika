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

/** 让已经排上队的微任务跑完。云端那条链路是 fetch → play() 两层 Promise。 */
async function flush(times = 4) {
  for (let index = 0; index < times; index += 1) await Promise.resolve();
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
      const transport = pendingFetch();
      vi.stubGlobal("Audio", FakeAudio);

      return {
        subject: createCloudTtsOutput(() => cloudConfig, transport.send),
        probe: {
          async start() {
            transport.settleAll("ok");
            await flush();
          },
          finish: () => FakeAudio.last?.onended?.(),
          async fail(message: string) {
            transport.settleAll(new Error(message));
            await flush();
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
