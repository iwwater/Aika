import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderConfig } from "../domain/providers";
import { listModels, sendChat, streamChat } from "./providerClient";

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

    expect(reply).toMatchObject({ japaneseText: "こんにちは", chineseTranslation: "你好", mood: "neutral", schemaVersion: 1 });
    expect(request.mock.calls[0][0]).toBe("https://example.com/v1/chat/completions");
    expect(JSON.parse(request.mock.calls[0][1].body).messages[0]).toEqual({ role: "system", content: "system" });
  });

  it("keeps a non-JSON reply as the japanese body instead of losing the turn", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ choices: [{ message: { content: "元気だよ" } }] })));
    await expect(sendChat(baseConfig, "system", [{ role: "user", content: "元気？" }]))
      .resolves.toMatchObject({ japaneseText: "元気だよ", chineseTranslation: "", mood: "neutral", schemaVersion: 1 });
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

  it("rejects a JSON object without visible reply text instead of showing raw protocol", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      choices: [{ message: { content: '{"mood":"happy","actions":[]}' } }],
    })));
    await expect(sendChat(baseConfig, "system", [{ role: "user", content: "hi" }]))
      .rejects.toThrow("没有返回可显示的文本");
  });

  it("canonical replyText 为 null 时不回退旧正文，生产 Provider 显式失败", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      choices: [{ message: { content: JSON.stringify({
        replyText: null,
        japanese_text: "旧正文不应显示",
      }) } }],
    })));
    await expect(sendChat(baseConfig, "system", [{ role: "user", content: "hi" }]))
      .rejects.toThrow("没有返回可显示的文本");
  });

  it("把取消信号传给 Provider 请求", async () => {
    const controller = new AbortController();
    const request = vi.fn().mockResolvedValue(jsonResponse({ choices: [{ message: { content: replyJson } }] }));
    vi.stubGlobal("fetch", request);

    await sendChat(baseConfig, "system", [{ role: "user", content: "hi" }], [], {
      signal: controller.signal,
      turnId: 9,
    });

    expect(request.mock.calls[0][1].signal).toBe(controller.signal);
  });

  it("请求开始前已取消时不发请求，也不退回成第二次调用", async () => {
    const controller = new AbortController();
    controller.abort();
    const request = vi.fn();
    vi.stubGlobal("fetch", request);

    await expect(streamChat(
      baseConfig,
      "system",
      [{ role: "user", content: "hi" }],
      () => undefined,
      [],
      { signal: controller.signal, turnId: 10 },
    )).rejects.toMatchObject({ name: "AbortError" });
    expect(request).not.toHaveBeenCalled();
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
      'data: {"choices":[{"delta":{"content":"{\\"replyText\\":\\"こん"}}]}',
      'data: {"choices":[{"delta":{"content":"にちは\\",\\"translation\\":\\"你好\\"}"}}]}',
      "data: [DONE]",
    ]));
    vi.stubGlobal("fetch", request);

    const seen: string[] = [];
    const reply = await streamChat(baseConfig, "system", [{ role: "user", content: "你好" }], (partial) => {
      seen.push(partial.japaneseText);
    });

    expect(seen[0]).toBe("こん");
    expect(reply).toMatchObject({ japaneseText: "こんにちは", chineseTranslation: "你好", mood: "neutral", schemaVersion: 1 });
    expect(JSON.parse(request.mock.calls[0][1].body).stream).toBe(true);
  });

  it("旧正文先到、canonical 后到时下游增量不回退且不重复", async () => {
    const deltas = [
      '{"japanese_text":"旧正文。",',
      '"replyText":"新正文。"}',
    ];
    const request = vi.fn().mockResolvedValue(sseResponse([
      ...deltas.map((content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}`),
      "data: [DONE]",
    ]));
    vi.stubGlobal("fetch", request);

    const seen: string[] = [];
    const reply = await streamChat(baseConfig, "system", [{ role: "user", content: "你好" }], (partial) => {
      seen.push(partial.japaneseText);
    });

    expect(seen).toEqual(["新正文。"]);
    expect(reply.japaneseText).toBe("新正文。");
    expect(seen[seen.length - 1]).toBe(reply.japaneseText);
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

    expect(reply).toMatchObject({ japaneseText: "こんにちは", chineseTranslation: "你好", mood: "neutral", schemaVersion: 1 });
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

  it("流在不完整 JSON 结束时失败，不把协议残片当普通正文", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseResponse([
      'data: {"choices":[{"delta":{"content":"{\\"replyText\\":\\"hi\\""}}]}',
      "data: [DONE]",
    ])));

    await expect(streamChat(baseConfig, "system", [{ role: "user", content: "hi" }], () => undefined))
      .rejects.toThrow("没有返回可显示的文本");
  });

  it("流是空的时候退回非流式", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(sseResponse(["data: [DONE]"]))
      .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: replyJson } }] }));
    vi.stubGlobal("fetch", request);
    const reply = await streamChat(baseConfig, "system", [{ role: "user", content: "hi" }], () => undefined);
    expect(reply.japaneseText).toBe("こんにちは");
  });

  it("首个 chunk 后取消时屏蔽迟到流，不重发整轮", async () => {
    const controller = new AbortController();
    let sent = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(stream) {
        if (sent) return;
        sent = true;
        stream.enqueue(new TextEncoder().encode(
          'data: {"choices":[{"delta":{"content":"{\\"replyText\\":\\"こん"}}]}\n',
        ));
      },
    }), { status: 200 });
    const request = vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", request);

    await expect(streamChat(
      baseConfig,
      "system",
      [{ role: "user", content: "hi" }],
      () => controller.abort(),
      [],
      { signal: controller.signal, turnId: 11 },
    )).rejects.toMatchObject({ name: "AbortError" });
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe("listModels", () => {
  it("requests the OpenAI-compatible models endpoint and returns sorted ids", async () => {
    const request = vi.fn().mockResolvedValue(jsonResponse({ data: [{ id: "qwen-turbo" }, { id: "qwen-plus" }, { id: "qwen-max" }] }));
    vi.stubGlobal("fetch", request);

    const models = await listModels(baseConfig);

    expect(models).toEqual(["qwen-max", "qwen-plus", "qwen-turbo"]);
    expect(request.mock.calls[0][0]).toBe("https://example.com/v1/models");
    expect(request.mock.calls[0][1].headers.Authorization).toBe("Bearer secret");
  });

  it("uses Anthropic headers for its models endpoint", async () => {
    const request = vi.fn().mockResolvedValue(jsonResponse({ data: [{ id: "claude-sonnet-4-5" }] }));
    vi.stubGlobal("fetch", request);

    await listModels({ ...baseConfig, protocol: "anthropic", baseUrl: "https://api.anthropic.com" });

    expect(request.mock.calls[0][0]).toBe("https://api.anthropic.com/v1/models");
    expect(request.mock.calls[0][1].headers["x-api-key"]).toBe("secret");
  });

  it("strips the models/ prefix and keeps only generateContent-capable Gemini models", async () => {
    const request = vi.fn().mockResolvedValue(jsonResponse({
      models: [
        { name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] },
        { name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"] },
        { name: "models/gemini-2.5-pro", supportedGenerationMethods: ["generateContent"] },
      ],
    }));
    vi.stubGlobal("fetch", request);

    const models = await listModels(
      { ...baseConfig, protocol: "gemini", baseUrl: "https://generativelanguage.googleapis.com" },
    );

    expect(models).toEqual(["gemini-2.5-flash", "gemini-2.5-pro"]);
    expect(request.mock.calls[0][0]).toContain("/v1beta/models?pageSize=100&key=secret");
  });

  it("names the host it actually called when the models endpoint fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: { message: "bad key" } }, 401)));
    await expect(listModels(baseConfig)).rejects.toThrow("example.com 返回 401：bad key");
  });

  it("reports an empty list instead of fabricating one", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ data: [] })));
    await expect(listModels(baseConfig)).resolves.toEqual([]);
  });
});
