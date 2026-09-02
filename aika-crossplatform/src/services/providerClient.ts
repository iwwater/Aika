import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import type { ChatTurn } from "../domain/conversation";
import type { ProviderConfig } from "../domain/providers";
import { cleanBaseUrl } from "../domain/providers";

export type { ChatTurn } from "../domain/conversation";

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

export async function sendChat(config: ProviderConfig, systemPrompt: string, history: ChatTurn[]): Promise<string> {
  const base = cleanBaseUrl(config.baseUrl);
  let data: any;

  if (config.protocol === "openai-responses") {
    data = await postJson(base.endsWith("/responses") ? base : `${base}/responses`, { Authorization: `Bearer ${config.apiKey}` }, {
      model: config.model,
      instructions: systemPrompt,
      input: history.map((turn) => ({ role: turn.role, content: turn.content })),
    });
    const text = responsesText(data);
    if (!text) throw new Error("API 已响应，但没有返回可显示的文本");
    return text;
  }

  if (config.protocol === "anthropic") {
    data = await postJson(base.endsWith("/v1/messages") ? base : `${base}/v1/messages`, {
      "x-api-key": config.apiKey,
      "anthropic-version": "2023-06-01",
    }, { model: config.model, max_tokens: 800, system: systemPrompt, messages: history });
    const text = data.content?.map((item: any) => item.text ?? "").join("").trim();
    if (!text) throw new Error("API 已响应，但没有返回可显示的文本");
    return text;
  }

  if (config.protocol === "gemini") {
    const endpoint = base.includes(":generateContent") ? base : `${base}/v1beta/models/${encodeURIComponent(config.model)}:generateContent`;
    data = await postJson(`${endpoint}?key=${encodeURIComponent(config.apiKey)}`, {}, {
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: history.map((turn) => ({ role: turn.role === "assistant" ? "model" : "user", parts: [{ text: turn.content }] })),
    });
    const text = data.candidates?.[0]?.content?.parts?.map((part: any) => part.text ?? "").join("").trim();
    if (!text) throw new Error("API 已响应，但没有返回可显示的文本");
    return text;
  }

  data = await postJson(base.endsWith("/chat/completions") ? base : `${base}/chat/completions`, { Authorization: `Bearer ${config.apiKey}` }, {
    model: config.model,
    messages: [{ role: "system", content: systemPrompt }, ...history],
    temperature: 0.85,
  });
  const content = data.choices?.[0]?.message?.content;
  const text = typeof content === "string" ? content : content?.map((part: any) => part.text ?? "").join("").trim();
  if (!text) throw new Error("API 已响应，但没有返回可显示的文本");
  return text;
}

export async function testProvider(config: ProviderConfig): Promise<string> {
  await sendChat(config, "只回复 OK。", [{ role: "user", content: "连接测试" }]);
  return "连接成功，API 可以正常使用";
}
