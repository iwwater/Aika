import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { companionReplySchema, parseCompanionReply, type CompanionReply } from "../domain/companion";
import type { ChatTurn } from "../domain/conversation";
import type { ProviderConfig } from "../domain/providers";
import { cleanBaseUrl } from "../domain/providers";
import { parsePartialReply, type PartialReply } from "../domain/streamingReply";

export type { ChatTurn } from "../domain/conversation";
export type { CompanionReply } from "../domain/companion";
export type { PartialReply } from "../domain/streamingReply";

/**
 * 请求的期望输出格式。
 * - companion-reply：结构化双语回复，支持的协议会声明 schema。
 * - json：记忆抽取这类需要 JSON 但结构由提示词约定的请求。
 * - text：滚动摘要这类纯文本请求。
 */
type ResponseFormat = "companion-reply" | "json" | "text";

interface PreparedRequest {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

function activeFetch(input: string, init: RequestInit): Promise<Response> {
  return "__TAURI_INTERNALS__" in globalThis ? tauriFetch(input, init) : globalThis.fetch(input, init);
}

async function readError(response: Response): Promise<string> {
  const text = await response.text();
  if (!text) return `${response.status} ${response.statusText}`;
  try {
    const body = JSON.parse(text);
    return body.error?.message ?? body.message ?? text.slice(0, 400);
  } catch {
    return text.slice(0, 400);
  }
}

/** 报错必须说清楚请求发去了哪儿：官方端点和中转站的 401 含义完全不同。 */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

async function post(request: PreparedRequest): Promise<Response> {
  const host = hostOf(request.url);
  let response: Response;
  try {
    response = await activeFetch(request.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...request.headers },
      body: JSON.stringify(request.body),
      connectTimeout: 15_000,
    } as RequestInit);
  } catch (error) {
    throw new Error(`无法连接 ${host}：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) {
    throw new Error(`${host} 返回 ${response.status}：${await readError(response)}`);
  }
  return response;
}

function responsesText(data: any): string {
  if (typeof data.output_text === "string" && data.output_text) return data.output_text;
  const parts = data.output?.flatMap((item: any) => item.content ?? []) ?? [];
  return parts.map((part: any) => part.text ?? "").join("").trim();
}

/**
 * 把一轮请求翻成某个协议的 URL、请求头和请求体。
 * 流式和非流式只差 `stream` 这一个开关，所以共用这里，避免两套代码慢慢长歪。
 */
function prepare(
  config: ProviderConfig,
  systemPrompt: string,
  history: ChatTurn[],
  format: ResponseFormat,
  stream: boolean,
  /** 这一轮她能挑的表情包 id。空数组时结构化输出里根本没有这个字段。 */
  stickerIds: readonly string[] = [],
): PreparedRequest {
  const base = cleanBaseUrl(config.baseUrl);

  if (config.protocol === "openai-responses") {
    return {
      url: base.endsWith("/responses") ? base : `${base}/responses`,
      headers: { Authorization: `Bearer ${config.apiKey}` },
      body: {
        model: config.model,
        instructions: systemPrompt,
        input: history.map((turn) => ({ role: turn.role, content: turn.content })),
        ...(stream ? { stream: true } : {}),
        ...(format === "companion-reply"
          ? {
              text: {
                format: {
                  type: "json_schema",
                  name: "aika_companion_reply",
                  strict: true,
                  schema: companionReplySchema(stickerIds),
                },
              },
            }
          : {}),
      },
    };
  }

  if (config.protocol === "anthropic") {
    return {
      url: base.endsWith("/v1/messages") ? base : `${base}/v1/messages`,
      headers: { "x-api-key": config.apiKey, "anthropic-version": "2023-06-01" },
      body: {
        model: config.model,
        max_tokens: 800,
        system: systemPrompt,
        messages: history,
        ...(stream ? { stream: true } : {}),
      },
    };
  }

  if (config.protocol === "gemini") {
    const method = stream ? "streamGenerateContent" : "generateContent";
    const endpoint = base.includes(":generateContent") || base.includes(":streamGenerateContent")
      ? base
      : `${base}/v1beta/models/${encodeURIComponent(config.model)}:${method}`;
    const query = `?key=${encodeURIComponent(config.apiKey)}${stream ? "&alt=sse" : ""}`;
    return {
      url: `${endpoint}${query}`,
      headers: {},
      body: {
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: history.map((turn) => ({
          role: turn.role === "assistant" ? "model" : "user",
          parts: [{ text: turn.content }],
        })),
        ...(format === "text" ? {} : { generationConfig: { responseMimeType: "application/json" } }),
      },
    };
  }

  return {
    url: base.endsWith("/chat/completions") ? base : `${base}/chat/completions`,
    headers: { Authorization: `Bearer ${config.apiKey}` },
    body: {
      model: config.model,
      messages: [{ role: "system", content: systemPrompt }, ...history],
      temperature: format === "companion-reply" ? 0.85 : 0.3,
      ...(stream ? { stream: true } : {}),
    },
  };
}

function extractText(config: ProviderConfig, data: any): string {
  if (config.protocol === "openai-responses") return responsesText(data);
  if (config.protocol === "anthropic") {
    return data.content?.map((item: any) => item.text ?? "").join("").trim() ?? "";
  }
  if (config.protocol === "gemini") {
    return data.candidates?.[0]?.content?.parts?.map((part: any) => part.text ?? "").join("").trim() ?? "";
  }
  const content = data.choices?.[0]?.message?.content;
  return (typeof content === "string"
    ? content
    : content?.map((part: any) => part.text ?? "").join("").trim()) ?? "";
}

async function requestText(
  config: ProviderConfig,
  systemPrompt: string,
  history: ChatTurn[],
  format: ResponseFormat,
  stickerIds: readonly string[] = [],
): Promise<string> {
  const response = await post(prepare(config, systemPrompt, history, format, false, stickerIds));
  return extractText(config, await response.json());
}

/** 从一个 SSE 事件的 data 里取出这一小段新增文本。取不到就返回空串。 */
function deltaOf(config: ProviderConfig, payload: any): string {
  if (config.protocol === "openai-responses") {
    return typeof payload.delta === "string" ? payload.delta : "";
  }
  if (config.protocol === "anthropic") {
    return typeof payload.delta?.text === "string" ? payload.delta.text : "";
  }
  if (config.protocol === "gemini") {
    return payload.candidates?.[0]?.content?.parts?.map((part: any) => part.text ?? "").join("") ?? "";
  }
  const delta = payload.choices?.[0]?.delta?.content;
  return typeof delta === "string" ? delta : "";
}

/**
 * 逐行读 SSE。
 *
 * 只认 `data:` 行：`event:` 行的类型信息各家不一样，而 data 的形状足够区分，
 * 少认一种就少一处会随上游改版而坏掉的地方。
 */
async function readEventStream(response: Response, onData: (payload: any) => void): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("这个响应没有可读的流式内容");

  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");

      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        onData(JSON.parse(data));
      } catch {
        // 半行 JSON 或心跳注释，跳过就好，不该让一轮对话失败。
      }
    }
  }
}

/**
 * 请求一轮回复。
 * 支持结构化输出的协议会声明 schema；其余协议只靠提示词约定，
 * 由 parseCompanionReply 容错解析，模型不按格式返回时整段当日语正文，不丢这一轮。
 */
export async function sendChat(
  config: ProviderConfig,
  systemPrompt: string,
  history: ChatTurn[],
  stickerIds: readonly string[] = [],
): Promise<CompanionReply> {
  return finish(await requestText(config, systemPrompt, history, "companion-reply", stickerIds));
}

function finish(text: string): CompanionReply {
  if (!text) throw new Error("API 已响应，但没有返回可显示的文本");
  const reply = parseCompanionReply(text);
  if (!reply.japaneseText && !reply.chineseTranslation) {
    throw new Error("API 已响应，但没有返回可显示的文本");
  }
  return reply;
}

/**
 * 流式请求一轮回复。
 *
 * `onPartial` 每收到一小段就被调用一次，用来让第一句尽早出声、聊天气泡逐字长出来。
 * 返回值仍然是解析好的完整回复，落库和上下文都用它，不用调用方自己拼。
 *
 * **收到第一段之前失败就退回非流式。** 很多中转站不支持 `stream: true`，
 * 为这个让整轮对话失败不值得。已经吐过内容再断，就只能报错——那时候退回重来
 * 会把同一句念两遍。
 */
export async function streamChat(
  config: ProviderConfig,
  systemPrompt: string,
  history: ChatTurn[],
  onPartial: (partial: PartialReply) => void,
  stickerIds: readonly string[] = [],
): Promise<CompanionReply> {
  let raw = "";

  try {
    const response = await post(prepare(config, systemPrompt, history, "companion-reply", true, stickerIds));
    await readEventStream(response, (payload) => {
      const delta = deltaOf(config, payload);
      if (!delta) return;
      raw += delta;
      onPartial(parsePartialReply(raw));
    });
  } catch (error) {
    if (raw) throw error;
    return sendChat(config, systemPrompt, history, stickerIds);
  }

  if (!raw) return sendChat(config, systemPrompt, history, stickerIds);
  return finish(raw);
}

/** 记忆抽取用：需要 JSON，但结构由提示词约定。 */
export function requestJson(config: ProviderConfig, systemPrompt: string, history: ChatTurn[]) {
  return requestText(config, systemPrompt, history, "json");
}

/** 滚动摘要用：纯文本。 */
export function requestPlainText(config: ProviderConfig, systemPrompt: string, history: ChatTurn[]) {
  return requestText(config, systemPrompt, history, "text");
}

export async function testProvider(config: ProviderConfig): Promise<string> {
  await sendChat(config, "只回复 OK。", [{ role: "user", content: "连接测试" }]);
  return "连接成功，API 可以正常使用";
}
