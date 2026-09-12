/**
 * 平台上报的用量（LLM-10）。
 *
 * 四家的字段名不同（`prompt_tokens` / `input_tokens` / `promptTokenCount`…），语义
 * 一致，所以归一成这三个。**缺失一律 null**：写 0 会让成本页把「不知道」画成
 * 「不花钱」。
 *
 * 放在 domain 而不是 providerClient 旁边：Runtime 与 Trace 都要认识这个形状，
 * 让它们 import 一个 HTTP 客户端模块只是为了拿类型，等于把实现拖进编排层。
 */
export interface ProviderUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  /** 平台报了就用平台的；只报了两个分项就相加；缺一项就是 null。 */
  totalTokens: number | null;
}

export type ApiProtocol =
  | "openai-responses"
  | "openai-compatible"
  | "anthropic"
  | "gemini";

export interface ProviderConfig {
  id: string;
  name: string;
  protocol: ApiProtocol;
  baseUrl: string;
  model: string;
  apiKey: string;
}

export const PROVIDER_PRESETS: ProviderConfig[] = [
  { id: "openai", name: "OpenAI", protocol: "openai-responses", baseUrl: "https://api.openai.com/v1", model: "gpt-4.1-mini", apiKey: "" },
  { id: "qwen", name: "通义千问", protocol: "openai-compatible", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus", apiKey: "" },
  { id: "deepseek", name: "DeepSeek", protocol: "openai-compatible", baseUrl: "https://api.deepseek.com", model: "deepseek-chat", apiKey: "" },
  { id: "anthropic", name: "Claude", protocol: "anthropic", baseUrl: "https://api.anthropic.com", model: "claude-sonnet-4-5", apiKey: "" },
  { id: "gemini", name: "Gemini", protocol: "gemini", baseUrl: "https://generativelanguage.googleapis.com", model: "gemini-2.5-flash", apiKey: "" },
  { id: "custom", name: "自定义兼容接口", protocol: "openai-compatible", baseUrl: "", model: "", apiKey: "" },
];

export function cleanBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

export function validateProvider(config: ProviderConfig): string | null {
  if (!config.baseUrl.trim()) return "请填写 API 地址";
  try {
    const url = new URL(config.baseUrl);
    if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
      return "远程 API 地址必须使用 HTTPS";
    }
  } catch {
    return "API 地址格式不正确";
  }
  if (!config.model.trim()) return "请填写模型名称";
  if (!config.apiKey.trim()) return "请填写 API Key";
  return null;
}

export function normalizeStoredProvider(config: ProviderConfig): ProviderConfig {
  const preset = PROVIDER_PRESETS.find((item) => item.id === config.id);
  return preset && preset.id !== "custom"
    ? { ...config, name: preset.name, protocol: preset.protocol }
    : config;
}
