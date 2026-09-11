/**
 * 把现有 providerClient.streamChat 适配成 Runtime 的 Provider 端口。
 *
 * streamChat 是「回调 + 返回完整回复」的形状，Runtime 需要的是 AsyncIterable：
 * 只有拿到迭代器，取消时才能通过 for-await 的 return() 真正关掉底层流。
 * 这里用一个队列把回调增量转成事件流，不做任何解析——解析仍归 domain 层。
 */

import type { CompanionReply, ReplyEnvelopeV1 } from "../../domain/companion";
import { formatRetrievedSections, toCompanionContext } from "../../domain/context";
import { buildConversationInput, buildInstructions } from "../../domain/prompt";
import type { ProviderConfig } from "../../domain/providers";
import { DEFAULT_CHARACTER_SOUL, type CharacterSoul } from "../../domain/soul";
import type { Sticker } from "../../domain/stickers";
import { describeChatRequest, isAbortError, streamChat, testProvider, listModels } from "../providerClient";
import { digestText } from "../../domain/trace";
import { NO_TRACE, type TraceRecorder } from "../trace/traceRecorder";
import type { ProviderStreamEvent, RuntimeGenerateInput, RuntimeProvider } from "./companionRuntime";
import type { ProviderModels, ProviderProbe } from "./tokens";

export interface StreamChatProviderOptions {
  getConfig(): ProviderConfig;
  getStickers?(): readonly Sticker[];
  soul?: CharacterSoul;
  /** Trace 记录器。不传等于不记（NO_TRACE）。 */
  trace?: TraceRecorder;
}

function toEnvelope(reply: CompanionReply): ReplyEnvelopeV1 {
  return {
    schemaVersion: 1,
    mood: reply.mood,
    replyText: reply.replyText ?? reply.japaneseText,
    translation: reply.translation ?? reply.chineseTranslation,
    memoryCandidates: reply.memoryCandidates ?? [],
    actions: reply.actions ?? [],
    ...(reply.sticker ? { sticker: reply.sticker } : {}),
    ...(reply.expression ? { expression: reply.expression } : {}),
    ...(reply.motion ? { motion: reply.motion } : {}),
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function* generateEvents(
  input: RuntimeGenerateInput,
  options: StreamChatProviderOptions,
): AsyncGenerator<ProviderStreamEvent> {
  const stickers = options.getStickers?.() ?? [];
  const companion = toCompanionContext(input.context);
  const retrieved = formatRetrievedSections(input.context);
  const instructions = [
    buildInstructions(companion, options.soul ?? DEFAULT_CHARACTER_SOUL, stickers, input.mode),
    retrieved,
  ].filter((block) => block.trim().length > 0).join("\n\n");

  if (input.signal.aborted) return;

  const config = options.getConfig();
  const userContent = input.source === "proactive"
    ? input.context.query
    : buildConversationInput(input.context.query, companion);
  const history = [{ role: "user" as const, content: userContent }];
  // 端点与请求体大小都问 providerClient 要，不在这里照抄 URL 规则。
  const described = describeChatRequest(config, instructions, history, stickers.map((sticker) => sticker.id));
  (options.trace ?? NO_TRACE).record(input.turnId, {
    kind: "provider_request",
    protocol: config.protocol,
    model: config.model,
    // key 还在 URL 里（Gemini 的 ?key=）；砍 query 是 recorder 统一做的事。
    endpoint: described.url,
    requestChars: described.bodyChars,
    instructionsChars: instructions.length,
    instructionsDigest: digestText(instructions),
  });

  const controller = new AbortController();
  const queue: ProviderStreamEvent[] = [];
  let notify: (() => void) | null = null;
  let finished = false;
  const wake = () => {
    const pending = notify;
    notify = null;
    pending?.();
  };
  const onAbort = () => {
    controller.abort();
    queue.length = 0;
    finished = true;
    wake();
  };
  input.signal.addEventListener("abort", onAbort, { once: true });

  const pump = (async () => {
    try {
      const reply = await streamChat(
        config,
        instructions,
        history,
        (partial) => {
          if (controller.signal.aborted) return;
          queue.push({
            type: "delta",
            text: partial.japaneseText,
            translation: partial.chineseTranslation,
            mood: partial.mood,
          });
          wake();
        },
        stickers.map((sticker) => sticker.id),
        { signal: controller.signal },
      );
      if (!controller.signal.aborted) queue.push({ type: "reply", reply: toEnvelope(reply) });
    } catch (error) {
      // 取消由 Runtime 判为 cancelled，这里不能把它当成 provider 错误。
      if (controller.signal.aborted || isAbortError(error)) return;
      queue.push({ type: "error", code: "PROVIDER_FAILED", retryable: true, message: messageOf(error) });
    } finally {
      finished = true;
      wake();
    }
  })();

  try {
    for (;;) {
      while (queue.length) yield queue.shift() as ProviderStreamEvent;
      if (finished) return;
      await new Promise<void>((resolve) => {
        notify = resolve;
      });
      notify = null;
    }
  } finally {
    controller.abort();
    input.signal.removeEventListener("abort", onAbort);
    void pump.catch(() => undefined);
  }
}

export function createStreamChatProvider(options: StreamChatProviderOptions): RuntimeProvider {
  return {
    generate(input: RuntimeGenerateInput): AsyncIterable<ProviderStreamEvent> {
      return generateEvents(input, options);
    },
  };
}

/**
 * 设置页的「测试连接」。
 *
 * 它同样是 Provider 侧能力，放在适配器这一层，`App.tsx` 因此不再直接 import
 * providerClient；全仓 providerClient 的调用方只剩本模块与记忆抽取。
 */
export const providerProbe: ProviderProbe = (config) => testProvider(config);

/**
 * 设置页「获取模型列表」，同样放在适配器这一层走端口。
 */
export const providerModels: ProviderModels = (config) => listModels(config);
