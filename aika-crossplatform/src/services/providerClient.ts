import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { COMPANION_REPLY_SCHEMA, parseCompanionReply, type CompanionReply } from "../domain/companion";
import type { ChatTurn } from "../domain/conversation";
import type { ProviderConfig } from "../domain/providers";
import { cleanBaseUrl } from "../domain/providers";

export type { ChatTurn } from "../domain/conversation";
export type { CompanionReply } from "../domain/companion";

/**
 * 请求的期望输出格式。
 * - companion-reply：结构化双语回复，支持的协议会声明 schema。
 * - json：记忆抽取这类需要 JSON 但结构由提示词约定的请求。
 * - text：滚动摘要这类纯文本请求。
 */
type ResponseFormat = "companion-reply" | "json" | "text";

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

async function postJson(url: string, headers: Record<string, string>, body: unknown) {
  let response: Response;
  try {
    response = await activeFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      connectTimeout: 15_000,
    } as RequestInit);
  } catch (error) {
    throw new Error(`无法连接 API：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) throw new Error(`API 返回 ${response.status}：${await readError(response)}`);
  return response.json();
}

function responsesText(data: any): string {
  if (typeof data.output_text === "string" && data.output_text) return data.output_text;
  const parts = data.output?.flatMap((item: any) => item.content ?? []) ?? [];
  return parts.map((part: any) => part.text ?? "").join("").trim();
}

async function requestText(
  config: ProviderConfig,
  systemPrompt: string,
  history: ChatTurn[],
  format: ResponseFormat,
): Promise<string> {
  const base = cleanBaseUrl(config.baseUrl);

  if (config.protocol === "openai-responses") {
    const data = await postJson(
      base.endsWith("/responses") ? base : `${base}/responses`,
      { Authorization: `Bearer ${config.apiKey}` },
      {
        model: config.model,
        instructions: systemPrompt,
        input: history.map((turn) => ({ role: turn.role, content: turn.content })),
        ...(format === "companion-reply"
          ? {
              text: {
                format: {
                  type: "json_schema",
                  name: "aika_companion_reply",
                  strict: true,
                  schema: COMPANION_REPLY_SCHEMA,
                },
              },
            }
          : {}),
      },
    );
    return responsesText(data);
  }

  if (config.protocol === "anthropic") {
    const data = await postJson(
      base.endsWith("/v1/messages") ? base : `${base}/v1/messages`,
      { "x-api-key": config.apiKey, "anthropic-version": "2023-06-01" },
      { model: config.model, max_tokens: 800, system: systemPrompt, messages: history },
    );
    return data.content?.map((item: any) => item.text ?? "").join("").trim() ?? "";
  }

  if (config.protocol === "gemini") {
    const endpoint = base.includes(":generateContent")
      ? base
      : `${base}/v1beta/models/${encodeURIComponent(config.model)}:generateContent`;
    const data = await postJson(`${endpoint}?key=${encodeURIComponent(config.apiKey)}`, {}, {
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: history.map((turn) => ({
        role: turn.role === "assistant" ? "model" : "user",
        parts: [{ text: turn.content }],
      })),
      ...(format === "text" ? {} : { generationConfig: { responseMimeType: "application/json" } }),
    });
    return data.candidates?.[0]?.content?.parts?.map((part: any) => part.text ?? "").join("").trim() ?? "";
  }

  const data = await postJson(
    base.endsWith("/chat/completions") ? base : `${base}/chat/completions`,
    { Authorization: `Bearer ${config.apiKey}` },
    {
      model: config.model,
      messages: [{ role: "system", content: systemPrompt }, ...history],
      temperature: format === "companion-reply" ? 0.85 : 0.3,
    },
  );
  const content = data.choices?.[0]?.message?.content;
  return (typeof content === "string"
    ? content
    : content?.map((part: any) => part.text ?? "").join("").trim()) ?? "";
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
): Promise<CompanionReply> {
  const text = await requestText(config, systemPrompt, history, "companion-reply");
  if (!text) throw new Error("API 已响应，但没有返回可显示的文本");
  const reply = parseCompanionReply(text);
  if (!reply.japaneseText && !reply.chineseTranslation) {
    throw new Error("API 已响应，但没有返回可显示的文本");
  }
  return reply;
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
