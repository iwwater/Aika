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

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("sendChat", () => {
  it("uses the OpenAI-compatible chat endpoint and returns its text", async () => {
    const request = vi.fn().mockResolvedValue(jsonResponse({ choices: [{ message: { content: "こんにちは" } }] }));
    vi.stubGlobal("fetch", request);

    const text = await sendChat(baseConfig, "system", [{ role: "user", content: "你好" }]);

    expect(text).toBe("こんにちは");
    expect(request.mock.calls[0][0]).toBe("https://example.com/v1/chat/completions");
    expect(JSON.parse(request.mock.calls[0][1].body).messages[0]).toEqual({ role: "system", content: "system" });
  });

  it("parses OpenAI Responses output", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ output: [{ content: [{ text: "元気だよ" }] }] })));
    await expect(sendChat({ ...baseConfig, protocol: "openai-responses" }, "system", [{ role: "user", content: "元気？" }])).resolves.toBe("元気だよ");
  });

  it("uses Anthropic headers and parses content blocks", async () => {
    const request = vi.fn().mockResolvedValue(jsonResponse({ content: [{ type: "text", text: "そうだね" }] }));
    vi.stubGlobal("fetch", request);
    const text = await sendChat({ ...baseConfig, protocol: "anthropic", baseUrl: "https://api.anthropic.com" }, "system", [{ role: "user", content: "ね" }]);
    expect(text).toBe("そうだね");
    expect(request.mock.calls[0][0]).toBe("https://api.anthropic.com/v1/messages");
    expect(request.mock.calls[0][1].headers["x-api-key"]).toBe("secret");
  });

  it("builds a Gemini request and parses candidate parts", async () => {
    const request = vi.fn().mockResolvedValue(jsonResponse({ candidates: [{ content: { parts: [{ text: "いいよ" }] } }] }));
    vi.stubGlobal("fetch", request);
    const text = await sendChat({ ...baseConfig, protocol: "gemini", baseUrl: "https://generativelanguage.googleapis.com" }, "system", [{ role: "user", content: "話そう" }]);
    expect(text).toBe("いいよ");
    expect(request.mock.calls[0][0]).toContain("/v1beta/models/test-model:generateContent?key=secret");
  });

  it("surfaces the provider error message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: { message: "invalid key" } }, 401)));
    await expect(sendChat(baseConfig, "system", [{ role: "user", content: "hi" }])).rejects.toThrow("API 返回 401：invalid key");
  });
});
