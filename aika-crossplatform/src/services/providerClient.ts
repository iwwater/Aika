import { activeFetch } from "./http";
import { companionReplySchema, parseCompanionReply, type CompanionReply } from "../domain/companion";
import type { ChatTurn } from "../domain/conversation";
import type { ProviderConfig, ProviderUsage } from "../domain/providers";
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

export type { ProviderUsage } from "../domain/providers";

export interface ProviderRequestOptions {
  /** 取消整轮 LLM 请求和 SSE reader；调用方仍须用 turnId 屏蔽不支持取消的迟到结果。 */
  signal?: AbortSignal;
  turnId?: number;
  /**
   * 平台报了用量就叫一次——**至多一次**，内部退回非流式时合并后再叫。
   *
   * 之所以是回调而不是返回值的一部分：取消与失败的轮次没有回复，但那时候
   * 已经烧掉的 token 同样要能记账。
   */
  onUsage?: (usage: ProviderUsage) => void;
  /**
   * 物理请求计量（LLM-04 RequestMetric）。**每次真实网络尝试各计一条**：
   * 流式内部退回非流式、受控 fallback 都是独立的 attempt，不能用逻辑回合数
   * 把重试并成一次。purpose/turnId 由调用方声明——这里不知道自己是前台
   * 生成还是后台维护。
   */
  requestPurpose?: "foreground" | "maintenance";
  requestTurnId?: string;
  onRequestMetric?: (metric: RequestMetric) => void;
}

/** 一次物理 Provider 请求尝试的计量记录（LLM-04-A/C）。 */
export interface RequestMetric {
  turnId: string;
  purpose: "foreground" | "maintenance";
  attempt: number;
  status: "started" | "completed" | "failed" | "cancelled";
}

/** 带状态码的 HTTP 错误：流式重试要靠它分辨「请求体不对」和「网络/服务端炸了」。 */
export class ProviderHttpError extends Error {
  constructor(readonly status: number, readonly host: string, message: string) {
    super(message);
    this.name = "ProviderHttpError";
  }
}

function numberOr(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** 两个分项都在才相加——相加是算术，拿半个数字当全量才是发明。 */
function totalOf(reported: unknown, prompt: number | null, completion: number | null): number | null {
  const total = numberOr(reported);
  if (total !== null) return total;
  return prompt !== null && completion !== null ? prompt + completion : null;
}

function emptyUsage(): ProviderUsage {
  return { promptTokens: null, completionTokens: null, totalTokens: null };
}

export function hasUsage(usage: ProviderUsage): boolean {
  return usage.promptTokens !== null || usage.completionTokens !== null || usage.totalTokens !== null;
}

/**
 * 从一份响应（或一个流式 chunk）里取用量。取不到就返回全 null。
 *
 * 按**形状**认而不是按协议分支：同一个协议在流式与非流式下 usage 挂的位置不同
 * （responses 挂在 `response.usage`，anthropic 分散在 `message.usage` 与
 * `usage`），分支写四遍迟早漏一处。
 */
export function extractUsage(payload: any): ProviderUsage {
  if (!payload || typeof payload !== "object") return emptyUsage();
  const usage = payload.usage ?? payload.response?.usage ?? payload.message?.usage ?? payload.usageMetadata;
  if (!usage || typeof usage !== "object") return emptyUsage();

  const prompt = numberOr(usage.prompt_tokens) ?? numberOr(usage.input_tokens) ?? numberOr(usage.promptTokenCount);
  const completion = numberOr(usage.completion_tokens) ?? numberOr(usage.output_tokens)
    ?? numberOr(usage.candidatesTokenCount);
  return {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: totalOf(usage.total_tokens ?? usage.totalTokenCount, prompt, completion),
  };
}

/**
 * 流式里 usage 是**逐块累积**的：Anthropic 的 input 在 `message_start`、output 在
 * `message_delta`，两次都只有一半。所以按字段合并而不是后者覆盖前者。
 */
function mergeUsage(base: ProviderUsage, next: ProviderUsage): ProviderUsage {
  const promptTokens = next.promptTokens ?? base.promptTokens;
  const completionTokens = next.completionTokens ?? base.completionTokens;
  return {
    promptTokens,
    completionTokens,
    totalTokens: totalOf(next.totalTokens ?? base.totalTokens, promptTokens, completionTokens),
  };
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}

export function isAbortError(error: unknown): boolean {
  return (error instanceof DOMException && error.name === "AbortError")
    || (error instanceof Error && error.name === "AbortError");
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw abortError();
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

async function post(request: PreparedRequest, options: ProviderRequestOptions = {}): Promise<Response> {
  throwIfAborted(options.signal);
  const host = hostOf(request.url);
  let response: Response;
  try {
    response = await activeFetch(request.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...request.headers },
      body: JSON.stringify(request.body),
      connectTimeout: 15_000,
      signal: options.signal,
    } as RequestInit);
  } catch (error) {
    throw new Error(`无法连接 ${host}：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) {
    throw new ProviderHttpError(response.status, host, `${host} 返回 ${response.status}：${await readError(response)}`);
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
  /**
   * 流式里要不要主动索要用量（LLM-10）。
   *
   * 只对 openai-compatible 有意义：它流式默认不报 usage。其余三家流式本来就带，
   * 不需要多塞字段——多塞一个字段就多一处会被中转站 400 掉的地方。
   */
  includeUsage = true,
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
      ...(stream && includeUsage ? { stream_options: { include_usage: true } } : {}),
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
  options: ProviderRequestOptions = {},
): Promise<string> {
  emitMetric(options, 1, "started");
  try {
    const response = await post(prepare(config, systemPrompt, history, format, false, stickerIds), options);
    const data = await response.json();
    reportUsage(options, extractUsage(data));
    emitMetric(options, 1, "completed");
    return extractText(config, data);
  } catch (error) {
    // post() 会包装连接错误；调用方已取消的轮次按 cancelled 记，不冒充 failed。
    emitMetric(options, 1, options.signal?.aborted || isAbortError(error) ? "cancelled" : "failed");
    throw error;
  }
}

/** 有东西才叫回调：全 null 的用量等于没拿到，不值得让下游记一笔「都是 null」。 */
function reportUsage(options: ProviderRequestOptions, usage: ProviderUsage): void {
  if (hasUsage(usage)) options.onUsage?.(usage);
}

/** 计量回调也没拿到就不发：没挂 sink 的调用方不为它付构造记录的代价。 */
function emitMetric(
  options: ProviderRequestOptions,
  attempt: number,
  status: RequestMetric["status"],
): void {
  options.onRequestMetric?.({
    turnId: options.requestTurnId ?? "",
    purpose: options.requestPurpose ?? "foreground",
    attempt,
    status,
  });
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
async function readEventStream(
  response: Response,
  onData: (payload: any) => void,
  signal?: AbortSignal,
): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("这个响应没有可读的流式内容");

  const onAbort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      if (done) break;
      throwIfAborted(signal);
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
  } finally {
    signal?.removeEventListener("abort", onAbort);
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
  options: ProviderRequestOptions = {},
): Promise<CompanionReply> {
  return finish(await requestText(config, systemPrompt, history, "companion-reply", stickerIds, options));
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
  options: ProviderRequestOptions = {},
): Promise<CompanionReply> {
  let raw = "";
  let lastPartial: PartialReply | null = null;
  let metricAttempt = 0;

  function emitPartial(partial: PartialReply) {
    if (!partial.japaneseText && !partial.chineseTranslation
      && partial.mood === "neutral" && !partial.japaneseComplete) {
      return;
    }
    // Provider chunk 在字段结束符/翻译到达时可能不再增加正文；不把相同快照
    // 重复发给字幕/TTS 下游，且允许 mood/translation 等其它字段单独更新。
    if (lastPartial
      && lastPartial.japaneseText === partial.japaneseText
      && lastPartial.chineseTranslation === partial.chineseTranslation
      && lastPartial.mood === partial.mood
      && lastPartial.japaneseComplete === partial.japaneseComplete) {
      return;
    }
    lastPartial = partial;
    onPartial(partial);
  }

  let usage = emptyUsage();

  /**
   * 跑一次流式。`includeUsage` 为 false 时不带 `stream_options`——那是给
   * 不认识这个字段的中转站的第二次机会。
   */
  async function runStream(includeUsage: boolean): Promise<void> {
    // 计数按物理尝试递增：4xx 去掉 stream_options 的第二次机会也是一次真实请求。
    metricAttempt += 1;
    const attempt = metricAttempt;
    emitMetric(options, attempt, "started");
    try {
      const response = await post(
        prepare(config, systemPrompt, history, "companion-reply", true, stickerIds, includeUsage),
        options,
      );
      await readEventStream(response, (payload) => {
        // usage 可能挂在一个没有正文的 chunk 上（OpenAI 末尾那个 choices: []），
        // 所以先收用量再判断有没有 delta，顺序反了就永远收不到。
        usage = mergeUsage(usage, extractUsage(payload));
        const delta = deltaOf(config, payload);
        if (!delta) return;
        raw += delta;
        emitPartial(parsePartialReply(raw));
      }, options.signal);
      emitMetric(options, attempt, "completed");
    } catch (error) {
      emitMetric(options, attempt, options.signal?.aborted || isAbortError(error) ? "cancelled" : "failed");
      throw error;
    }
  }

  try {
    try {
      await runStream(true);
    } catch (error) {
      // 只在「还没吐过任何内容」且「是请求体层面的 4xx」时才去掉 stream_options 重来：
      // 为了统计 token 把流式弄没了是本末倒置，但网络断了或 500 时重试只是浪费一次请求。
      if (raw || options.signal?.aborted || isAbortError(error)) throw error;
      if (!(error instanceof ProviderHttpError) || error.status < 400 || error.status >= 500) throw error;
      await runStream(false);
    }
  } catch (error) {
    if (options.signal?.aborted || isAbortError(error)) throw (options.signal?.aborted ? abortError() : error);
    if (raw) throw error;
    return fallbackNonStream();
  }

  reportUsage(options, usage);

  throwIfAborted(options.signal);
  if (!raw) return fallbackNonStream();
  return finish(raw);

  /**
   * 退回非流式。
   *
   * 用量在这里合并后**只回调一次**：调用方不该因为内部退了一次而收到两份用量，
   * 自己去猜哪一份算数。
   */
  async function fallbackNonStream(): Promise<CompanionReply> {
    // 这次退回也是一次独立的物理请求：自己计数，并屏蔽内层 sendChat 的重复计量。
    metricAttempt += 1;
    const attempt = metricAttempt;
    emitMetric(options, attempt, "started");
    let fallbackUsage = emptyUsage();
    try {
      const reply = await sendChat(config, systemPrompt, history, stickerIds, {
        ...options,
        onRequestMetric: undefined,
        onUsage: (value) => {
          fallbackUsage = value;
        },
      });
      emitMetric(options, attempt, "completed");
      reportUsage(options, mergeUsage(usage, fallbackUsage));
      return reply;
    } catch (error) {
      emitMetric(options, attempt, options.signal?.aborted || isAbortError(error) ? "cancelled" : "failed");
      throw error;
    }
  }
}

/**
 * 这一轮真实请求长什么样——只读，不发请求。
 *
 * Trace 的 `provider_request` 需要真实 endpoint 与请求体大小。**不能在别处照抄
 * URL 规则**：四种协议各拼各的（Gemini 还要 `:streamGenerateContent` 加 query），
 * 抄一份出去迟早和真实请求漂移，那时 Trace 报的地址就是假的。所以这里复用同一个
 * `prepare()`，调用方拿到的和真正发出去的是同一份。
 *
 * 返回的 url 里可能带凭据（Gemini 的 `?key=`）；砍掉 query 是 Trace 侧的事，
 * 这里不替调用方决定要不要脱敏。
 */
export function describeChatRequest(
  config: ProviderConfig,
  systemPrompt: string,
  history: ChatTurn[],
  stickerIds: readonly string[] = [],
  stream = true,
): { url: string; bodyChars: number } {
  const prepared = prepare(config, systemPrompt, history, "companion-reply", stream, stickerIds);
  return { url: prepared.url, bodyChars: JSON.stringify(prepared.body).length };
}

/** 记忆抽取用：需要 JSON，但结构由提示词约定。options 允许维护调用带计量。 */
export function requestJson(
  config: ProviderConfig,
  systemPrompt: string,
  history: ChatTurn[],
  options: ProviderRequestOptions = {},
) {
  return requestText(config, systemPrompt, history, "json", [], options);
}

/** 滚动摘要用：纯文本。options 允许维护调用带计量。 */
export function requestPlainText(
  config: ProviderConfig,
  systemPrompt: string,
  history: ChatTurn[],
  options: ProviderRequestOptions = {},
) {
  return requestText(config, systemPrompt, history, "text", [], options);
}

/** 设置页拉取模型列表用的 GET 请求端点与请求头。 */
function modelsEndpoint(config: ProviderConfig): { url: string; headers: Record<string, string> } {
  const base = cleanBaseUrl(config.baseUrl);

  if (config.protocol === "anthropic") {
    return {
      url: `${base}/v1/models`,
      headers: { "x-api-key": config.apiKey, "anthropic-version": "2023-06-01" },
    };
  }
  if (config.protocol === "gemini") {
    return {
      url: `${base}/v1beta/models?pageSize=100&key=${encodeURIComponent(config.apiKey)}`,
      headers: {},
    };
  }
  // openai-compatible 与 openai-responses 共用 OpenAI 的 /models。
  return { url: `${base}/models`, headers: { Authorization: `Bearer ${config.apiKey}` } };
}

function modelIdsOf(config: ProviderConfig, data: any): string[] {
  if (config.protocol === "gemini") {
    // 只留能对话的模型，并去掉路径前缀——generateContent 的 URL 里写的是裸模型名。
    const models = Array.isArray(data.models) ? data.models : [];
    return models
      .filter((model: any) => model.supportedGenerationMethods?.includes("generateContent"))
      .map((model: any) => String(model.name ?? "").replace(/^models\//, ""))
      .filter((name: string) => name.length > 0);
  }
  const rows = Array.isArray(data.data) ? data.data : [];
  return rows.map((row: any) => row.id).filter((id: unknown): id is string => typeof id === "string" && id.length > 0);
}

/**
 * 拉取该平台可用的模型列表，按字典序返回模型 ID，供设置页下拉选择。
 * 端点随协议而异；失败时把发出请求的主机名报出来，与对话请求同一口径。
 */
export async function listModels(
  config: ProviderConfig,
  options: ProviderRequestOptions = {},
): Promise<string[]> {
  const { url, headers } = modelsEndpoint(config);
  throwIfAborted(options.signal);
  const host = hostOf(url);
  let response: Response;
  try {
    response = await activeFetch(url, {
      method: "GET",
      headers,
      connectTimeout: 15_000,
      signal: options.signal,
    } as RequestInit);
  } catch (error) {
    throw new Error(`无法连接 ${host}：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) {
    throw new Error(`${host} 返回 ${response.status}：${await readError(response)}`);
  }
  return modelIdsOf(config, await response.json()).sort((a, b) => a.localeCompare(b));
}

export async function testProvider(config: ProviderConfig): Promise<string> {
  await sendChat(config, "只回复 OK。", [{ role: "user", content: "连接测试" }]);
  return "连接成功，API 可以正常使用";
}
