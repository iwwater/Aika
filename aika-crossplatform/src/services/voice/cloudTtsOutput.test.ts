import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanBaseUrl, DEFAULT_CLOUD_TTS, requestKey, resolveSpeed, synthesize, type CloudTtsConfig,
} from "./cloudTtsOutput";

afterEach(() => vi.unstubAllGlobals());

const config: CloudTtsConfig = {
  ...DEFAULT_CLOUD_TTS,
  baseUrl: "https://api.example.com/v1",
  model: "tts-x",
  voice: "shimmer",
  apiKey: "sk-test",
};

function audioResponse(bytes: number[], status = 200) {
  return new Response(new Uint8Array(bytes), { status });
}

describe("resolveSpeed", () => {
  it("没给语速就是 1", () => {
    expect(resolveSpeed()).toBe(1);
    expect(resolveSpeed(undefined)).toBe(1);
  });

  it("夹在对面接受的区间里，超出会被 400 拒掉", () => {
    expect(resolveSpeed(0.05)).toBe(0.25);
    expect(resolveSpeed(9)).toBe(4);
  });

  it("坏值退回 1，不把 NaN 送出去", () => {
    expect(resolveSpeed(Number.NaN)).toBe(1);
    expect(resolveSpeed(0)).toBe(1);
    expect(resolveSpeed(-2)).toBe(1);
  });

  it("取两位小数：浮点误差不该算出两个不同的缓存键", () => {
    // 0.94 * 1.1 在 IEEE754 里是 1.0340000000000003
    expect(resolveSpeed(0.94 * 1.1)).toBe(resolveSpeed(1.034));
  });
});

describe("cleanBaseUrl", () => {
  it("去掉首尾空白和结尾斜杠", () => {
    expect(cleanBaseUrl("  https://api.example.com/v1/  ")).toBe("https://api.example.com/v1");
    expect(cleanBaseUrl("https://api.example.com/v1///")).toBe("https://api.example.com/v1");
  });
});

describe("requestKey", () => {
  it("同一句同一语速算出同一个键——预取和播放必须命中同一次请求", () => {
    expect(requestKey(config, "おかえり。", resolveSpeed(1.03)))
      .toBe(requestKey(config, "おかえり。", resolveSpeed(1.03)));
  });

  it("语速不同就是两段不同的音频", () => {
    expect(requestKey(config, "おかえり。", resolveSpeed(0.8)))
      .not.toBe(requestKey(config, "おかえり。", resolveSpeed(1)));
  });

  it("换音色或换模型都要换键", () => {
    const other = { ...config, voice: "coral" };
    expect(requestKey(other, "おかえり。", 1)).not.toBe(requestKey(config, "おかえり。", 1));
    expect(requestKey({ ...config, model: "tts-y" }, "おかえり。", 1))
      .not.toBe(requestKey(config, "おかえり。", 1));
  });

  it("结尾斜杠不影响键：同一个服务不该被当成两个", () => {
    expect(requestKey({ ...config, baseUrl: "https://api.example.com/v1/" }, "おかえり。", 1))
      .toBe(requestKey(config, "おかえり。", 1));
  });
});

describe("synthesize", () => {
  it("往 /audio/speech 发，请求体带模型、音色、语速", async () => {
    const request = vi.fn().mockResolvedValue(audioResponse([1, 2, 3]));
    vi.stubGlobal("fetch", request);

    const buffer = await synthesize(config, "おかえり。", 0.8);
    expect(buffer.byteLength).toBe(3);

    expect(request.mock.calls[0][0]).toBe("https://api.example.com/v1/audio/speech");
    const init = request.mock.calls[0][1];
    expect(init.headers.Authorization).toBe("Bearer sk-test");
    expect(JSON.parse(init.body)).toEqual({
      model: "tts-x",
      voice: "shimmer",
      input: "おかえり。",
      speed: 0.8,
      response_format: "mp3",
    });
  });

  it("不送语言：一个音色念三种语言，语言不影响请求", async () => {
    const request = vi.fn().mockResolvedValue(audioResponse([1]));
    vi.stubGlobal("fetch", request);

    await synthesize(config, "Take your time.", 1);
    expect(JSON.parse(request.mock.calls[0][1].body)).not.toHaveProperty("language");
  });

  it("对面报错时把正文带出来——只说「返回 401」帮不上忙", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response('{"error":{"message":"Incorrect API key provided"}}', { status: 401 }),
    ));

    // 只发一次：Response 的 body 是一次性的流，同一个对象读第二遍就是空的
    let message = "";
    try {
      await synthesize(config, "おかえり。", 1);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("401");
    expect(message).toContain("Incorrect API key");
  });

  it("空音频当失败：静默播放和成功长得一模一样", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(audioResponse([])));
    await expect(synthesize(config, "おかえり。", 1)).rejects.toThrow(/空音频/);
  });

  it("连不上时报错要说清楚是哪个地址", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    await expect(synthesize(config, "おかえり。", 1))
      .rejects.toThrow(/https:\/\/api\.example\.com\/v1\/audio\/speech/);
  });
});
