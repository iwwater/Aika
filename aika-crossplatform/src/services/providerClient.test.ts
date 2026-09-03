import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderConfig } from "../domain/providers";
import { sendChat, streamChat } from "./providerClient";

const baseConfig: ProviderConfig = {
  id: "test",
  name: "Test",
  protocol: "openai-compatible",
  baseUrl: "https://example.com/v1/",
  model: "test-model",
  apiKey: "secret",
};

const replyJson = '{"japanese_text":"こんにちは","chinese_translation":"你好"}';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("sendChat", () => {
  it("uses the OpenAI-compatible chat endpoint and returns the structured reply", async () => {
    const request = vi.fn().mockResolvedValue(jsonResponse({ choices: [{ message: { content: replyJson } }] }));
    vi.stubGlobal("fetch", request);

    const reply = await sendChat(baseConfig, "system", [{ role: "user", content: "你好" }]);

    expect(reply).toEqual({ japaneseText: "こんにちは", chineseTranslation: "你好", mood: "neutral" });
    expect(request.mock.calls[0][0]).toBe("https://example.com/v1/chat/completions");
    expect(JSON.parse(request.mock.calls[0][1].body).messages[0]).toEqual({ role: "system", content: "system" });
  });

  it("keeps a non-JSON reply as the japanese body instead of losing the turn", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ choices: [{ message: { content: "元気だよ" } }] })));
    await expect(sendChat(baseConfig, "system", [{ role: "user", content: "元気？" }]))
      .resolves.toEqual({ japaneseText: "元気だよ", chineseTranslation: "", mood: "neutral" });
  });

  it("asks OpenAI Responses for the bilingual schema and parses its output", async () => {
    const request = vi.fn().mockResolvedValue(jsonResponse({ output: [{ content: [{ text: replyJson }] }] }));
    vi.stubGlobal("fetch", request);
    const reply = await sendChat({ ...baseConfig, protocol: "openai-responses" }, "system", [{ role: "user", content: "元気？" }]);
    expect(reply.chineseTranslation).toBe("你好");
    expect(JSON.parse(request.mock.calls[0][1].body).text.format.name).toBe("aika_companion_reply");
  });

  it("uses Anthropic headers and parses content blocks", async () => {
    const request = vi.fn().mockResolvedValue(jsonResponse({ content: [{ type: "text", text: replyJson }] }));
    vi.stubGlobal("fetch", request);
    const reply = await sendChat({ ...baseConfig, protocol: "anthropic", baseUrl: "https://api.anthropic.com" }, "system", [{ role: "user", content: "ね" }]);
    expect(reply.japaneseText).toBe("こんにちは");
    expect(request.mock.calls[0][0]).toBe("https://api.anthropic.com/v1/messages");
    expect(request.mock.calls[0][1].headers["x-api-key"]).toBe("secret");
  });

  it("builds a Gemini JSON request and parses candidate parts", async () => {
    const request = vi.fn().mockResolvedValue(jsonResponse({ candidates: [{ content: { parts: [{ text: replyJson }] } }] }));
    vi.stubGlobal("fetch", request);
    const reply = await sendChat({ ...baseConfig, protocol: "gemini", baseUrl: "https://generativelanguage.googleapis.com" }, "system", [{ role: "user", content: "話そう" }]);
    expect(reply.japaneseText).toBe("こんにちは");
    expect(request.mock.calls[0][0]).toContain("/v1beta/models/test-model:generateContent?key=secret");
    expect(JSON.parse(request.mock.calls[0][1].body).generationConfig.responseMimeType).toBe("application/json");
  });

  it("names the host it actually called, so a relay 401 is not mistaken for the official one", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: { message: "invalid key" } }, 401)));
    await expect(sendChat(baseConfig, "system", [{ role: "user", content: "hi" }]))
      .rejects.toThrow("example.com 返回 401：invalid key");
  });

  it("reports an empty response instead of showing a blank bubble", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ choices: [{ message: { content: "" } }] })));
    await expect(sendChat(baseConfig, "system", [{ role: "user", content: "hi" }])).rejects.toThrow("没有返回可显示的文本");
  });
});

function sseResponse(lines: string[]) {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const line of lines) controller.enqueue(encoder.encode(`${line}\n`));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

describe("streamChat", () => {
  it("边收边回调，最后返回解析好的完整回复", async () => {
    const request = vi.fn().mockResolvedValue(sseResponse([
      'data: {"choices":[{"delta":{"content":"{\\"japanese_text\\":\\"こん"}}]}',
      'data: {"choices":[{"delta":{"content":"にちは\\",\\"chinese_translation\\":\\"你好\\"}"}}]}',
      "data: [DONE]",
    ]));
    vi.stubGlobal("fetch", request);

    const seen: string[] = [];
    const reply = await streamChat(baseConfig, "system", [{ role: "user", content: "你好" }], (partial) => {
      seen.push(partial.japaneseText);
    });

    expect(seen[0]).toBe("こん");
    expect(reply).toEqual({ japaneseText: "こんにちは", chineseTranslation: "你好", mood: "neutral" });
    expect(JSON.parse(request.mock.calls[0][1].body).stream).toBe(true);
  });

  it("认得 Anthropic 的 content_block_delta", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseResponse([
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"元気だよ"}}',
    ])));
    const reply = await streamChat(
      { ...baseConfig, protocol: "anthropic", baseUrl: "https://api.anthropic.com" },
      "system", [{ role: "user", content: "ね" }], () => undefined,
    );
    expect(reply.japaneseText).toBe("元気だよ");
  });

  it("Gemini 走 streamGenerateContent 并带上 alt=sse", async () => {
    const request = vi.fn().mockResolvedValue(sseResponse([
      'data: {"candidates":[{"content":{"parts":[{"text":"元気だよ"}]}}]}',
    ]));
    vi.stubGlobal("fetch", request);
    await streamChat(
      { ...baseConfig, protocol: "gemini", baseUrl: "https://generativelanguage.googleapis.com" },
      "system", [{ role: "user", content: "話そう" }], () => undefined,
    );
    expect(request.mock.calls[0][0]).toContain(":streamGenerateContent?key=secret&alt=sse");
  });

  it("中转站不支持 stream 时安静退回非流式，不让整轮失败", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: { message: "stream not supported" } }, 400))
      .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: replyJson } }] }));
    vi.stubGlobal("fetch", request);

    const reply = await streamChat(baseConfig, "system", [{ role: "user", content: "hi" }], () => undefined);

    expect(reply).toEqual({ japaneseText: "こんにちは", chineseTranslation: "你好", mood: "neutral" });
    expect(JSON.parse(request.mock.calls[1][1].body).stream).toBeUndefined();
  });

  it("已经吐过内容再断就报错：退回重来会把同一句念两遍", async () => {
    let sent = false;
    const failing = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) {
          controller.error(new Error("connection reset"));
          return;
        }
        sent = true;
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"こん"}}]}\n'));
      },
    }), { status: 200 });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(failing));

    await expect(streamChat(baseConfig, "system", [{ role: "user", content: "hi" }], () => undefined))
      .rejects.toThrow("connection reset");
  });

  it("流是空的时候退回非流式", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(sseResponse(["data: [DONE]"]))
      .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: replyJson } }] }));
    vi.stubGlobal("fetch", request);
    const reply = await streamChat(baseConfig, "system", [{ role: "user", content: "hi" }], () => undefined);
    expect(reply.japaneseText).toBe("こんにちは");
  });
});
