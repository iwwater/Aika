import { vi } from "vitest";
import { runProviderConformance } from "./provider.conformance";
import { createStreamChatProvider } from "./providerAdapter";
import { buildContextClock } from "../../domain/context";
import { DEFAULT_CHARACTER_SOUL, DEFAULT_MODE_CONFIG } from "../../domain/soul";
import { computeRelationship, deriveRelationshipSignals } from "../../domain/relationship";
import type { ProviderConfig } from "../../domain/providers";

for (const protocol of ["openai-responses", "openai-compatible", "anthropic", "gemini"] as const) {
  runProviderConformance({
    name: protocol,
    create(scenario) {
      let signal: AbortSignal | undefined;
      const encode = (text: string) => {
        switch (protocol) {
          case "openai-responses": return { type: "response.output_text.delta", delta: text };
          case "anthropic": return { type: "content_block_delta", delta: { type: "text_delta", text } };
          case "gemini": return { candidates: [{ content: { parts: [{ text }] } }] };
          default: return { choices: [{ delta: { content: text } }] };
        }
      };
      const request = vi.fn(async (_url: string, init: RequestInit) => {
        signal = init.signal as AbortSignal;
        if (scenario === "error") throw new Error("fixture network failure");
        if (scenario === "hanging") return new Promise<Response>((_resolve, reject) => {
          signal!.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true });
        });
        const parts = ['{"replyText":"こん', 'にちは","translation":"你好"}'];
        const body = new ReadableStream<Uint8Array>({ start(controller) {
          for (const part of parts) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(encode(part))}\n\n`));
          controller.close();
        } });
        return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
      });
      vi.stubGlobal("fetch", request);
      const config: ProviderConfig = { id: "fixture", name: protocol, protocol, baseUrl: "https://fixture.invalid", model: "fixture", apiKey: "fixture" };
      return {
        subject: createStreamChatProvider({ getConfig: () => config }),
        input: {
          turnId: "fixture-turn", signal: new AbortController().signal, mode: DEFAULT_MODE_CONFIG,
          context: {
            schemaVersion: 1, query: "你好", clock: buildContextClock(1000, "UTC"),
            characterSoul: DEFAULT_CHARACTER_SOUL, userSoul: null,
            relationship: computeRelationship(deriveRelationshipSignals([], 1000)), mode: DEFAULT_MODE_CONFIG,
            recentConversation: [], summary: null, memories: [], knowledge: [], environment: [],
          },
        },
        requests: () => request.mock.calls.length,
        aborted: () => signal?.aborted ?? false,
        dispose: () => vi.unstubAllGlobals(),
      };
    },
  });
}
