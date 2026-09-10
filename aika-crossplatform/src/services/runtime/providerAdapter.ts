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
import { isAbortError, streamChat } from "../providerClient";
import type { ProviderStreamEvent, RuntimeGenerateInput, RuntimeProvider } from "./companionRuntime";

export interface StreamChatProviderOptions {
  getConfig(): ProviderConfig;
  getStickers?(): readonly Sticker[];
  soul?: CharacterSoul;
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

  const queue: ProviderStreamEvent[] = [];
  let notify: (() => void) | null = null;
  let finished = false;
  const wake = () => {
    const pending = notify;
    notify = null;
    pending?.();
  };
  const onAbort = () => {
    finished = true;
    wake();
  };
  input.signal.addEventListener("abort", onAbort, { once: true });

  const pump = (async () => {
    try {
      const reply = await streamChat(
        options.getConfig(),
        instructions,
        [{ role: "user", content: buildConversationInput(input.context.query, companion) }],
        (partial) => {
          queue.push({
            type: "delta",
            text: partial.japaneseText,
            translation: partial.chineseTranslation,
            mood: partial.mood,
          });
          wake();
        },
        stickers.map((sticker) => sticker.id),
        { signal: input.signal },
      );
      queue.push({ type: "reply", reply: toEnvelope(reply) });
    } catch (error) {
      // 取消由 Runtime 判为 cancelled，这里不能把它当成 provider 错误。
      if (input.signal.aborted || isAbortError(error)) return;
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
