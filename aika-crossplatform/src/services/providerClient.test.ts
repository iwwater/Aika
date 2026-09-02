import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderConfig } from "../domain/providers";
import { sendChat } from "./providerClient";

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

    expect(reply).toEqual({ japaneseText: "こんにちは", chineseTranslation: "你好" });
    expect(request.mock.calls[0][0]).toBe("https://example.com/v1/chat/completions");
    expect(JSON.parse(request.mock.calls[0][1].body).messages[0]).toEqual({ role: "system", content: "system" });
  });

  it("keeps a non-JSON reply as the japanese body instead of losing the turn", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ choices: [{ message: { content: "元気だよ" } }] })));
    await expect(sendChat(baseConfig, "system", [{ role: "user", content: "元気？" }]))
      .resolves.toEqual({ japaneseText: "元気だよ", chineseTranslation: "" });
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

  it("surfaces the provider error message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: { message: "invalid key" } }, 401)));
    await expect(sendChat(baseConfig, "system", [{ role: "user", content: "hi" }])).rejects.toThrow("API 返回 401：invalid key");
  });

  it("reports an empty response instead of showing a blank bubble", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ choices: [{ message: { content: "" } }] })));
    await expect(sendChat(baseConfig, "system", [{ role: "user", content: "hi" }])).rejects.toThrow("没有返回可显示的文本");
  });
});
