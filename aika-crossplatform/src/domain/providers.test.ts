import { describe, expect, it } from "vitest";
import { cleanBaseUrl, normalizeStoredProvider, validateProvider, type ProviderConfig } from "./providers";

const valid: ProviderConfig = { id: "x", name: "x", protocol: "openai-compatible", baseUrl: "https://example.com/v1", model: "model", apiKey: "key" };

describe("provider configuration", () => {
  it("normalizes trailing slashes", () => expect(cleanBaseUrl(" https://example.com/v1/// ")).toBe("https://example.com/v1"));
  it("accepts a complete HTTPS provider", () => expect(validateProvider(valid)).toBeNull());
  it("rejects missing keys and insecure remote URLs", () => {
    expect(validateProvider({ ...valid, apiKey: "" })).toBe("请填写 API Key");
    expect(validateProvider({ ...valid, baseUrl: "http://example.com" })).toBe("远程 API 地址必须使用 HTTPS");
  });
  it("allows local development endpoints", () => expect(validateProvider({ ...valid, baseUrl: "http://127.0.0.1:11434/v1" })).toBeNull());
  it("repairs a known provider with a stale protocol", () => {
    const repaired = normalizeStoredProvider({ ...valid, id: "deepseek", name: "old", protocol: "openai-responses" });
    expect(repaired.protocol).toBe("openai-compatible");
    expect(repaired.name).toBe("DeepSeek");
  });
});
