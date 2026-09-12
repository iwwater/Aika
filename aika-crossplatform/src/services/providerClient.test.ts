import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderConfig } from "../domain/providers";
import { listModels, sendChat, streamChat, type ProviderUsage } from "./providerClient";

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
    // LLM-10 之后这条路上多了一次尝试：先去掉 stream_options 再流式一遍（万一它只是
    // 不认识那个字段），仍然 400 才退回非流式。多出来的是一次失败请求，不烧 token。
    const request = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: { message: "stream not supported" } }, 400))
      .mockResolvedValueOnce(jsonResponse({ error: { message: "stream not supported" } }, 400))
      .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: replyJson } }] }));
    vi.stubGlobal("fetch", request);

    const reply = await streamChat(baseConfig, "system", [{ role: "user", content: "hi" }], () => undefined);

    expect(reply).toMatchObject({ japaneseText: "こんにちは", chineseTranslation: "你好", mood: "neutral", schemaVersion: 1 });
    expect(JSON.parse(request.mock.calls[1][1].body).stream_options).toBeUndefined();
    expect(JSON.parse(request.mock.calls[2][1].body).stream).toBeUndefined();
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

describe("LLM-10 用量上报", () => {
  const ask = async (config: ProviderConfig, stream = false) => {
    const seen: ProviderUsage[] = [];
    const call = stream
      ? streamChat(config, "system", [{ role: "user", content: "hi" }], () => undefined, [], {
        onUsage: (usage) => seen.push(usage),
      })
      : sendChat(config, "system", [{ role: "user", content: "hi" }], [], {
        onUsage: (usage) => seen.push(usage),
      });
    await call;
    return seen;
  };

  it("非流式：四种协议的 usage 都解析得出来（LLM-10-A）", async () => {
    const cases: [ProviderConfig["protocol"], unknown, ProviderUsage][] = [
      ["openai-compatible",
        { choices: [{ message: { content: replyJson } }], usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 } },
        { promptTokens: 120, completionTokens: 30, totalTokens: 150 }],
      ["openai-responses",
        { output: [{ content: [{ text: replyJson }] }], usage: { input_tokens: 90, output_tokens: 12, total_tokens: 102 } },
        { promptTokens: 90, completionTokens: 12, totalTokens: 102 }],
      ["anthropic",
        { content: [{ type: "text", text: replyJson }], usage: { input_tokens: 70, output_tokens: 20 } },
        // Anthropic 不报 total，两个分项都在所以相加——相加是算术，不是发明。
        { promptTokens: 70, completionTokens: 20, totalTokens: 90 }],
      ["gemini",
        { candidates: [{ content: { parts: [{ text: replyJson }] } }], usageMetadata: { promptTokenCount: 55, candidatesTokenCount: 8, totalTokenCount: 63 } },
        { promptTokens: 55, completionTokens: 8, totalTokens: 63 }],
    ];

    for (const [protocol, body, expected] of cases) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(body)));
      expect(await ask({ ...baseConfig, protocol }), protocol).toEqual([expected]);
    }
  });

  it("平台不报 usage 就一次都不回调（LLM-10-D）", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ choices: [{ message: { content: replyJson } }] })));

    // 「不知道」必须保持不知道：回调一份全 null 会让下游记一笔看似有数据的空账。
    expect(await ask(baseConfig)).toEqual([]);
  });

  it("缺一个分项时 total 为 null，不拿半个数字当全量（LLM-10-A）", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      choices: [{ message: { content: replyJson } }],
      usage: { prompt_tokens: 120 },
    })));

    expect(await ask(baseConfig)).toEqual([{ promptTokens: 120, completionTokens: null, totalTokens: null }]);
  });

  it("流式 openai-compatible：请求带 include_usage，末尾那个空 chunk 的用量收得到（LLM-10-B）", async () => {
    const request = vi.fn().mockResolvedValue(sseResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { content: replyJson } }] })}`,
      // 真实平台就是这样：最后一个 chunk 没有 choices，只有 usage。
      'data: {"choices":[],"usage":{"prompt_tokens":200,"completion_tokens":40,"total_tokens":240}}',
      "data: [DONE]",
    ]));
    vi.stubGlobal("fetch", request);

    expect(await ask(baseConfig, true)).toEqual([{ promptTokens: 200, completionTokens: 40, totalTokens: 240 }]);
    expect(JSON.parse(request.mock.calls[0][1].body).stream_options).toEqual({ include_usage: true });
  });

  it("流式 anthropic：message_start 与 message_delta 各报一半，合并成一份（LLM-10-B）", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseResponse([
      'data: {"type":"message_start","message":{"usage":{"input_tokens":300}}}',
      `data: ${JSON.stringify({ type: "content_block_delta", delta: { text: replyJson } })}`,
      'data: {"type":"message_delta","usage":{"output_tokens":25}}',
    ])));

    // 后到的那半不能覆盖先到的那半，否则 input 永远丢。
    expect(await ask({ ...baseConfig, protocol: "anthropic" }, true))
      .toEqual([{ promptTokens: 300, completionTokens: 25, totalTokens: 325 }]);
  });

  it("流式 anthropic 不多塞 stream_options：它本来就报用量", async () => {
    const request = vi.fn().mockResolvedValue(sseResponse([
      `data: ${JSON.stringify({ type: "content_block_delta", delta: { text: replyJson } })}`,
    ]));
    vi.stubGlobal("fetch", request);
    await ask({ ...baseConfig, protocol: "anthropic" }, true);

    // 多塞一个字段就多一处会被中转站 400 掉的地方。
    expect(JSON.parse(request.mock.calls[0][1].body).stream_options).toBeUndefined();
  });

  it("流式 gemini：取最后一次 usageMetadata（LLM-10-B）", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseResponse([
      `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: replyJson }] } }], usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 2, totalTokenCount: 42 } })}`,
      `data: ${JSON.stringify({ usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 18, totalTokenCount: 58 } })}`,
    ])));

    expect(await ask({ ...baseConfig, protocol: "gemini" }, true))
      .toEqual([{ promptTokens: 40, completionTokens: 18, totalTokens: 58 }]);
  });

  it("流式 responses：response.completed 里的用量（LLM-10-B）", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseResponse([
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: replyJson })}`,
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":80,"output_tokens":16,"total_tokens":96}}}',
    ])));

    expect(await ask({ ...baseConfig, protocol: "openai-responses" }, true))
      .toEqual([{ promptTokens: 80, completionTokens: 16, totalTokens: 96 }]);
  });

  it("400 掉 stream_options 的中转站：去掉它再流式一次，流式不退化（LLM-10-C）", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: { message: "unknown field: stream_options" } }, 400))
      .mockResolvedValueOnce(sseResponse([
        `data: ${JSON.stringify({ choices: [{ delta: { content: replyJson } }] })}`,
        "data: [DONE]",
      ]));
    vi.stubGlobal("fetch", request);

    const seen: string[] = [];
    const reply = await streamChat(baseConfig, "system", [{ role: "user", content: "hi" }], (partial) => {
      seen.push(partial.japaneseText);
    });

    expect(reply.japaneseText).toBe("こんにちは");
    // 第二次仍然是流式：为了统计 token 把流式弄没了，是本末倒置。
    expect(request).toHaveBeenCalledTimes(2);
    expect(JSON.parse(request.mock.calls[1][1].body).stream).toBe(true);
    expect(JSON.parse(request.mock.calls[1][1].body).stream_options).toBeUndefined();
    expect(seen.length).toBeGreaterThan(0);
  });

  it("500 不重试去 stream_options：那跟请求体没关系（LLM-10-C）", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: { message: "upstream boom" } }, 500))
      .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: replyJson } }] }));
    vi.stubGlobal("fetch", request);

    await streamChat(baseConfig, "system", [{ role: "user", content: "hi" }], () => undefined);

    // 直接退非流式，不浪费一次注定同样失败的流式请求。
    expect(request).toHaveBeenCalledTimes(2);
    expect(JSON.parse(request.mock.calls[1][1].body).stream).toBeUndefined();
  });

  it("退回非流式时用量只回调一次，调用方不用猜哪份算数", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: { message: "no stream" } }, 400))
      .mockResolvedValueOnce(jsonResponse({ error: { message: "no stream" } }, 400))
      .mockResolvedValueOnce(jsonResponse({
        choices: [{ message: { content: replyJson } }],
        usage: { prompt_tokens: 11, completion_tokens: 2, total_tokens: 13 },
      })));

    expect(await ask(baseConfig, true)).toEqual([{ promptTokens: 11, completionTokens: 2, totalTokens: 13 }]);
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

describe("物理请求计量（LLM-04 RequestMetric）", () => {
  function collect() {
    const metrics: Array<{ turnId: string; purpose: string; attempt: number; status: string }> = [];
    return {
      metrics,
      onRequestMetric: (metric: { turnId: string; purpose: string; attempt: number; status: string }) => {
        metrics.push(metric);
      },
    };
  }

  it("sendChat 成功：一次物理尝试，started→completed，purpose/turnId 透传", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ choices: [{ message: { content: replyJson } }] })));
    const sink = collect();

    await sendChat(baseConfig, "system", [{ role: "user", content: "你好" }], [], {
      requestPurpose: "maintenance",
      requestTurnId: "turn-9",
      onRequestMetric: sink.onRequestMetric,
    });

    expect(sink.metrics).toEqual([
      { turnId: "turn-9", purpose: "maintenance", attempt: 1, status: "started" },
      { turnId: "turn-9", purpose: "maintenance", attempt: 1, status: "completed" },
    ]);
  });

  it("受控 fallback 的每次尝试独立计数：流式两次失败 + 非流式成功 = attempt 1/2/3", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: { message: "stream not supported" } }, 400))
      .mockResolvedValueOnce(jsonResponse({ error: { message: "stream not supported" } }, 400))
      .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: replyJson } }] }));
    vi.stubGlobal("fetch", request);
    const sink = collect();

    await streamChat(baseConfig, "system", [{ role: "user", content: "hi" }], () => undefined, [], {
      requestPurpose: "foreground",
      requestTurnId: "turn-1",
      onRequestMetric: sink.onRequestMetric,
    });

    expect(sink.metrics.map((metric) => `${metric.attempt}:${metric.status}`)).toEqual([
      "1:started", "1:failed", "2:started", "2:failed", "3:started", "3:completed",
    ]);
    expect(sink.metrics.every((metric) => metric.purpose === "foreground")).toBe(true);
  });

  it("取消的轮次计为 cancelled，不冒充 completed", async () => {
    const controller = new AbortController();
    const abortError = new Error("aborted");
    abortError.name = "AbortError";
    const request = vi.fn().mockImplementation(async () => {
      controller.abort();
      throw abortError;
    });
    vi.stubGlobal("fetch", request);
    const sink = collect();

    await expect(sendChat(baseConfig, "system", [{ role: "user", content: "你好" }], [], {
      signal: controller.signal,
      requestPurpose: "foreground",
      requestTurnId: "turn-x",
      onRequestMetric: sink.onRequestMetric,
    })).rejects.toThrow();
    expect(sink.metrics).toEqual([
      { turnId: "turn-x", purpose: "foreground", attempt: 1, status: "started" },
      { turnId: "turn-x", purpose: "foreground", attempt: 1, status: "cancelled" },
    ]);
  });
});

describe("物理请求用量样本（LLM-12）", () => {
  interface UsageSample {
    logicalRequestId: string;
    attempt: number;
    phase: string;
    usage?: ProviderUsage;
  }

  function collectUsage() {
    const samples: UsageSample[] = [];
    return {
      samples,
      onRequestUsage: (sample: UsageSample) => samples.push(sample),
    };
  }

  it("非流式：started→completed 各一条样本，completed 带这次尝试的用量", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      choices: [{ message: { content: replyJson } }],
      usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
    })));
    const sink = collectUsage();

    await sendChat(baseConfig, "system", [{ role: "user", content: "hi" }], [], {
      onRequestUsage: sink.onRequestUsage,
    });

    expect(sink.samples).toHaveLength(2);
    expect(sink.samples[0].phase).toBe("started");
    expect(sink.samples[1]).toMatchObject({
      phase: "completed",
      attempt: 1,
      usage: { promptTokens: 120, completionTokens: 30, totalTokens: 150 },
    });
    // 同一逻辑请求共享 logicalRequestId，attempt 不重复汇总。
    expect(sink.samples[0].logicalRequestId).toBe(sink.samples[1].logicalRequestId);
  });

  it("流式 4xx 去掉 stream_options 重试：两次尝试各自取证，不拿合并值冒充单次", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: { message: "unknown field: stream_options" } }, 400))
      .mockResolvedValueOnce(sseResponse([
        `data: ${JSON.stringify({ choices: [{ delta: { content: replyJson } }] })}`,
        'data: {"choices":[],"usage":{"prompt_tokens":200,"completion_tokens":40,"total_tokens":240}}',
        "data: [DONE]",
      ]));
    vi.stubGlobal("fetch", request);
    const sink = collectUsage();

    await streamChat(baseConfig, "system", [{ role: "user", content: "hi" }], () => undefined, [], {
      onRequestUsage: sink.onRequestUsage,
    });

    expect(sink.samples.map((sample) => `${sample.attempt}:${sample.phase}`))
      .toEqual(["1:started", "1:failed", "2:started", "2:completed"]);
    expect(new Set(sink.samples.map((sample) => sample.logicalRequestId)).size).toBe(1);
    // 第一次尝试（400）没有用量；第二次是完整 reported。
    expect(sink.samples[1].usage).toBeUndefined();
    expect(sink.samples[3].usage).toEqual({ promptTokens: 200, completionTokens: 40, totalTokens: 240 });
  });

  it("退回非流式：fallback 是独立 attempt，内层 sendChat 的样本被屏蔽不重复", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: { message: "upstream boom" } }, 500))
      .mockResolvedValueOnce(jsonResponse({
        choices: [{ message: { content: replyJson } }],
        usage: { prompt_tokens: 11, completion_tokens: 2, total_tokens: 13 },
      }));
    vi.stubGlobal("fetch", request);
    const sink = collectUsage();

    await streamChat(baseConfig, "system", [{ role: "user", content: "hi" }], () => undefined, [], {
      onRequestUsage: sink.onRequestUsage,
    });

    // 5xx 直接退非流式：attempt 1 流式失败 + attempt 2 非流式成功，只有四条样本。
    expect(sink.samples.map((sample) => `${sample.attempt}:${sample.phase}`))
      .toEqual(["1:started", "1:failed", "2:started", "2:completed"]);
    expect(sink.samples[3].usage).toEqual({ promptTokens: 11, completionTokens: 2, totalTokens: 13 });
  });

  it("断流前已收到的部分用量随终态带出（LLM-12-B partial 的样本来源）", async () => {
    const failingStream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode('data: {"type":"message_start","message":{"usage":{"input_tokens":300}}}\n'));
        // error() 会丢掉队列里还没读的块，所以错开一拍再断。
        setTimeout(() => controller.error(new Error("connection reset")), 0);
      },
    });
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(failingStream, { status: 200, headers: { "Content-Type": "text/event-stream" } }))
      // 退回非流式用的是 anthropic 形状：外层 config 的协议是 anthropic。
      .mockResolvedValueOnce(jsonResponse({ content: [{ type: "text", text: replyJson }] })));
    const sink = collectUsage();

    await streamChat({ ...baseConfig, protocol: "anthropic" }, "system", [{ role: "user", content: "hi" }],
      () => undefined, [], { onRequestUsage: sink.onRequestUsage });

    const failed = sink.samples.find((sample) => sample.attempt === 1 && sample.phase === "failed");
    expect(failed?.usage).toEqual({ promptTokens: 300, completionTokens: null, totalTokens: null });
  });

  it("显式 0 与显式 unknown 的边界：平台报 0 就带 0，没报就不带", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      choices: [{ message: { content: replyJson } }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    })));
    const sink = collectUsage();

    await sendChat(baseConfig, "system", [{ role: "user", content: "hi" }], [], {
      onRequestUsage: sink.onRequestUsage,
    });

    expect(sink.samples[1].usage).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });
  });

  it("未声明用途的请求，计量 purpose 记 unknown，不猜成 foreground（LLM-12-A）", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ choices: [{ message: { content: replyJson } }] })));
    const metrics: string[] = [];

    await sendChat(baseConfig, "system", [{ role: "user", content: "hi" }], [], {
      onRequestMetric: (metric) => metrics.push(metric.purpose),
    });

    expect(metrics).toEqual(["unknown", "unknown"]);
  });

  it("summary/proactive 用途顺着 requestPurpose 透传", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ choices: [{ message: { content: replyJson } }] })));
    const metrics: string[] = [];

    await sendChat(baseConfig, "system", [{ role: "user", content: "hi" }], [], {
      requestPurpose: "summary",
      onRequestMetric: (metric) => metrics.push(metric.purpose),
    });

    expect(metrics).toEqual(["summary", "summary"]);
  });
});
