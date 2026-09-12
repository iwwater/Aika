import { afterEach, describe, expect, it, vi } from "vitest";
import { buildMultipartBody } from "../http";
import { createWhisperClient, isLikelyHallucination, stripMarkers, WHISPER_PROBE_TIMEOUT_MS } from "./whisperClient";

afterEach(() => vi.unstubAllGlobals());

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const samples = Float32Array.from({ length: 1600 }, (_, index) => Math.sin(index / 10) * 0.4);

describe("buildMultipartBody", () => {
  it("字段和文件都在，边界闭合", () => {
    const { body, contentType } = buildMultipartBody(
      { language: "auto" },
      { field: "file", filename: "turn.wav", contentType: "audio/wav", bytes: new Uint8Array([1, 2, 3]) },
      "BOUND",
    );
    const text = new TextDecoder().decode(body);

    expect(contentType).toBe("multipart/form-data; boundary=BOUND");
    expect(text).toContain('name="language"');
    expect(text).toContain("auto");
    expect(text).toContain('filename="turn.wav"');
    expect(text).toContain("Content-Type: audio/wav");
    expect(text.endsWith("--BOUND--\r\n")).toBe(true);
  });

  it("二进制内容原样保留，不被文本处理弄坏", () => {
    const bytes = new Uint8Array([0, 255, 13, 10, 128]);
    const { body } = buildMultipartBody({}, {
      field: "file", filename: "a.wav", contentType: "audio/wav", bytes,
    }, "B");
    // 文件内容出现在结尾边界之前
    const marker = body.length - "\r\n--B--\r\n".length;
    expect(Array.from(body.slice(marker - bytes.length, marker))).toEqual([0, 255, 13, 10, 128]);
  });
});

describe("stripMarkers", () => {
  it("去掉非语音标记", () => {
    expect(stripMarkers("[BLANK_AUDIO]")).toBe("");
    expect(stripMarkers("(music) おかえり")).toBe("おかえり");
    expect(stripMarkers("*笑* 今日はどうだった")).toBe("今日はどうだった");
  });

  it("正常文本不受影响", () => {
    expect(stripMarkers("今日は疲れた。")).toBe("今日は疲れた。");
  });
});

describe("isLikelyHallucination", () => {
  it("认出纯静音段的固定幻听", () => {
    expect(isLikelyHallucination("ご視聴ありがとうございました")).toBe(true);
    expect(isLikelyHallucination("Thanks for watching!")).toBe(true);
    expect(isLikelyHallucination("")).toBe(true);
    expect(isLikelyHallucination("   ")).toBe(true);
  });

  it("用户真说了类似的话时不吞掉", () => {
    expect(isLikelyHallucination("今日はありがとうございました、本当に助かった")).toBe(false);
    expect(isLikelyHallucination("おかえり")).toBe(false);
  });
});

describe("createWhisperClient", () => {
  it("送 multipart 到 /inference，并固定用 auto 语言", async () => {
    const request = vi.fn().mockResolvedValue(jsonResponse({ text: "今日は疲れた。" }));
    vi.stubGlobal("fetch", request);

    const client = createWhisperClient(() => "http://127.0.0.1:8080/");
    expect(await client.transcribe(samples)).toBe("今日は疲れた。");

    expect(request.mock.calls[0][0]).toBe("http://127.0.0.1:8080/inference");
    const init = request.mock.calls[0][1];
    expect(init.headers["Content-Type"]).toContain("multipart/form-data; boundary=");
    const sent = new TextDecoder().decode(init.body);
    expect(sent).toContain('name="language"');
    expect(sent).toContain("auto");
    expect(sent).toContain("RIFF");
  });

  it("识别出幻听时当作没听到", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ text: "ご視聴ありがとうございました" })));
    const client = createWhisperClient(() => "http://127.0.0.1:8080");
    expect(await client.transcribe(samples)).toBe("");
  });

  it("非语音标记被清掉", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ text: "[BLANK_AUDIO] おかえり" })));
    const client = createWhisperClient(() => "http://127.0.0.1:8080");
    expect(await client.transcribe(samples)).toBe("おかえり");
  });

  it("空采样不发请求", async () => {
    const request = vi.fn();
    vi.stubGlobal("fetch", request);
    const client = createWhisperClient(() => "http://127.0.0.1:8080");
    expect(await client.transcribe(new Float32Array(0))).toBe("");
    expect(request).not.toHaveBeenCalled();
  });

  it("连不上时报错要说清楚是哪个地址", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const client = createWhisperClient(() => "http://127.0.0.1:9999");
    await expect(client.transcribe(samples)).rejects.toThrow("http://127.0.0.1:9999");
  });

  it("服务报错时不把错误当成识别结果", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "boom" }, 500)));
    const client = createWhisperClient(() => "http://127.0.0.1:8080");
    await expect(client.transcribe(samples)).rejects.toThrow("500");
  });

  it("probe 在服务活着时为真", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("ok", { status: 200 })));
    expect(await createWhisperClient(() => "http://127.0.0.1:8080").probe()).toBe(true);
  });

  it("probe 连不上时为假，不抛错", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    expect(await createWhisperClient(() => "http://127.0.0.1:8080").probe()).toBe(false);
  });

  it("probe 带上浏览器也认的超时，不只靠 connectTimeout（STT-04-G）", async () => {
    // `connectTimeout` 只有 Tauri 的 plugin-http 认，浏览器 fetch 直接忽略这个字段。
    // 它挡在「点完实时语音」和「真的开始听」之间，所以必须有一个两边都认的超时。
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await createWhisperClient(() => "http://127.0.0.1:8080").probe();

    const init = fetchMock.mock.calls[0][1] as RequestInit & { connectTimeout?: number };
    expect(init.connectTimeout).toBe(WHISPER_PROBE_TIMEOUT_MS);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("probe 超时后认输，不把语音页挂在那里（STT-04-G）", async () => {
    // 模拟「端口没人听、连接一直重试」：只有 abort 能结束它。
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    })));

    const startedAt = Date.now();
    expect(await createWhisperClient(() => "http://127.0.0.1:8080").probe()).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(WHISPER_PROBE_TIMEOUT_MS * 3);
  });
});
