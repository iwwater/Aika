import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationTurn } from "../../domain/companion";
import type { MemoryRecord } from "../../domain/memory";
import type { ProviderConfig } from "../../domain/providers";
import type { UsageLedgerRecorder } from "../usage/contracts";
import { createModelMemoryExtractor } from "./extractor";

const config: ProviderConfig = {
  id: "prov-test",
  name: "Test",
  protocol: "openai-compatible",
  baseUrl: "https://example.com/v1",
  model: "test-model",
  apiKey: "secret",
};

const turns: ConversationTurn[] = [
  { role: "user", text: "我每天傍晚都去散步" },
  { role: "companion", text: "そうなんですね" },
];

afterEach(() => vi.unstubAllGlobals());

function stubExtractReply(): void {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
    JSON.stringify({ choices: [{ message: { content: '[{"category":"偏好","content":"喜欢傍晚散步"}]' } }] }),
    { status: 200 },
  )));
}

describe("维护请求的用途声明（LLM-12-A）", () => {
  it("抽取记 maintenance，摘要记 summary——由实际调用方赋值", async () => {
    stubExtractReply();
    const purposes: string[] = [];
    const extractor = createModelMemoryExtractor(() => config);
    await extractor.extract(turns, [], { onRequestMetric: (metric) => purposes.push(metric.purpose) });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ choices: [{ message: { content: "まとめ" } }] }),
      { status: 200 },
    )));
    await extractor.summarize(null, "user：你好\nAika：こんにちは", {
      onRequestMetric: (metric) => purposes.push(metric.purpose),
    });

    expect(Array.from(new Set(purposes))).toEqual(["maintenance", "summary"]);
  });

  it("装了用量台账时，observe 收到真实配置与用途，包装后的 options 顺着请求走", async () => {
    stubExtractReply();
    const observed: Array<{ purpose: string; providerId: string; model: string }> = [];
    const recorder = {
      observe: (input: { options?: Record<string, unknown>; purpose: string; config: { id: string; model: string } }) => {
        observed.push({ purpose: input.purpose, providerId: input.config.id, model: input.config.model });
        // 显式改写 purpose：它出现在请求 options 里，就证明包装后的对象真的被用上了。
        return { ...(input.options ?? {}), requestPurpose: input.purpose };
      },
      diagnostics: () => ({ registered: 0, writeFailures: 0, dropped: 0 }),
    } as unknown as UsageLedgerRecorder;
    const purposes: string[] = [];
    const extractor = createModelMemoryExtractor(() => config, recorder);

    const extracted = await extractor.extract(turns, [], {
      onRequestMetric: (metric) => purposes.push(metric.purpose),
    });

    expect(observed).toEqual([{ purpose: "maintenance", providerId: "prov-test", model: "test-model" }]);
    // metric 的 purpose 来自包装后的 options——说明 observe 的返回值确实进了请求。
    expect(Array.from(new Set(purposes))).toEqual(["maintenance"]);
    expect(extracted.map((record: MemoryRecord) => record.content)).toEqual(["喜欢傍晚散步"]);
  });
});
