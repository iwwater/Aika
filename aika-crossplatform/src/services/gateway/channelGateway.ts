/**
 * Channel Gateway（GW-01）。
 *
 * 适配器（Telegram poller 等）只负责搬运字节；一切与编排/个人数据相关的事情
 * 只发生在 Gateway：去重、校验、绑定解析、提交 Runtime、回信路由。可靠性口径
 * 如实、不吹 exactly-once：
 *
 * - **先持久接收，再确认平台 offset**；提交 Runtime 前崩溃 → 重启后那条记录
 *   停在 accepted，恢复时标 unknown——**不自动重跑**（副作用可能已发生）。
 * - 同会话按到达顺序串行提交（每会话一条 ingest 链），跨会话互不阻塞。
 * - 回信目的地固定绑定原请求；LLM 正文改不了收件人。任意新目标必须显式走
 *   权限流程（RT-03），Gateway 不提供。
 * - outbox 送达不确认 → unknown 终态；只有平台声明支持相同幂等键才允许重试
 *   已发送未确认的消息。
 */

import {
  inboxKeyOf, MAX_OUTBOX_PENDING, MAX_OUTBOUND_ATTEMPTS, OUTBOX_TTL_MS, validatePayload,
  type GatewayInboundMessageV1, type InboxRecordV1, type OutboundMessageV1,
} from "../../domain/gateway";
import type { AikaStorage } from "../storage/contracts";
import { SETTING_KEYS } from "../storage/contracts";

export const GATEWAY_STORE_KEY = SETTING_KEYS.gatewayState;

/** Gateway 唯一允许的编排入口：不认识 LLM/Memory 的任何实现细节（GW-01-D）。 */
export interface GatewayRuntimePort {
  /** 提交一轮并等结算。scope 的 principalId 由 Gateway 用绑定关系解析。 */
  submit(input: {
    conversationId: string;
    principalId: string;
    text: string;
    source: "text";
  }): Promise<{ state: "completed" | "cancelled" | "failed"; replyText?: string }>;
}

/** 出站传输端口：返回三选一，断线不确认就是 unknown——由调用方如实记账。 */
export interface GatewayTransport {
  /** 平台是否支持相同幂等键的重复投递（支持才允许对 unknown 重试）。 */
  readonly supportsIdempotentDelivery: boolean;
  send(outbound: OutboundMessageV1): Promise<{ outcome: "sent" | "failed" | "unknown"; retryAfterMs?: number; error?: string }>;
}

/** 发件人绑定解析（RT-02 绑定服务）。没绑 = 没有服务。 */
export interface GatewayBindingPort {
  principalFor(account: { platform: string; botAccount: string; tenant: string; sender: string }): Promise<string | null>;
}

export interface ChannelGatewayOptions {
  loadStorage: () => Promise<AikaStorage>;
  runtime: GatewayRuntimePort;
  transport: GatewayTransport;
  bindings: GatewayBindingPort;
  clock?: () => number;
  idFactory?: () => string;
  maxAttempts?: number;
}

export type IngestVerdict =
  | { verdict: "accepted"; key: string; conversationId: string }
  | { verdict: "duplicate" | "rejected"; key?: string; reason?: string };

export interface ChannelGateway {
  ingest(message: GatewayInboundMessageV1): Promise<IngestVerdict>;
  /** 启动恢复：中断窗口如实标 unknown，绝不自动重跑副作用。 */
  recover(): Promise<{ inboxUnknown: number; outboxRequeued: number }>;
  /** 把一条回信按原目的地入队（destination 固定，LLM 改不了）。 */
  enqueueReply(input: { inReplyToKey?: string; destination: OutboundMessageV1["destination"]; text: string }): Promise<{ ok: boolean; reason?: string }>;
  /** 冲 outbox：按 nextAttemptAt 逐条投递，遵守 retry-after 与重试上限。 */
  flushOutbox(): Promise<{ attempted: number; sent: number; failed: number; unknown: number }>;
  inbox(): Promise<readonly InboxRecordV1[]>;
  outbox(): Promise<readonly OutboundMessageV1[]>;
}

interface StoredGatewayState {
  schemaVersion: 1;
  inbox: InboxRecordV1[];
  outbox: OutboundMessageV1[];
}

export function createChannelGateway(options: ChannelGatewayOptions): ChannelGateway {
  const clock = options.clock ?? (() => Date.now());
  const idFactory = options.idFactory ?? defaultIdFactory;
  const maxAttempts = Math.min(Math.max(1, options.maxAttempts ?? MAX_OUTBOUND_ATTEMPTS), MAX_OUTBOUND_ATTEMPTS);

  const inbox = new Map<string, InboxRecordV1>();
  const outbox = new Map<string, OutboundMessageV1>();
  let loaded = false;
  /** 同会话 ingest 串行链：到达顺序 = 提交顺序。 */
  const chains = new Map<string, Promise<unknown>>();

  async function persist(): Promise<void> {
    const storage = await options.loadStorage();
    const document: StoredGatewayState = {
      schemaVersion: 1,
      inbox: [...inbox.values()].slice(-500),
      outbox: [...outbox.values()],
    };
    await storage.setSetting(GATEWAY_STORE_KEY, JSON.stringify(document));
  }

  async function ensureLoaded(): Promise<void> {
    if (loaded) return;
    loaded = true;
    try {
      const storage = await options.loadStorage();
      const raw = await storage.getSetting(GATEWAY_STORE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as StoredGatewayState;
      if (parsed?.schemaVersion === 1) {
        for (const record of parsed.inbox ?? []) inbox.set(record.key, record);
        for (const record of parsed.outbox ?? []) outbox.set(record.outboundId, record);
      }
    } catch {
      // 损坏按空网关处理：去重键丢了最多是重复消息再走一次校验，不会凭空执行。
      inbox.clear();
      outbox.clear();
    }
  }

  function conversationOf(message: GatewayInboundMessageV1): string {
    // 群聊永远不是个人上下文：conversation 以 chat 为界（RT-02 scope 语义）。
    return message.isGroup
      ? `gw:${message.platform}:${message.tenant}:${message.chatId}`
      : `gw:${message.platform}:${message.tenant}:dm:${message.chatId}`;
  }

  async function processAccepted(record: InboxRecordV1): Promise<void> {
    const message = record.message;

    // 绑定解析与校验都发生在「提交前」：这一段崩溃了可以安全重来（无副作用）。
    const principalId = await options.bindings.principalFor({
      platform: message.platform, botAccount: message.botAccount,
      tenant: message.tenant, sender: message.sender,
    });
    if (!principalId) {
      record.state = "failed";
      record.note = "sender-not-bound";
      record.updatedAt = clock();
      await persist();
      return;
    }

    const payload = message.payload;
    const text = payload.kind === "text" ? payload.text
      : payload.kind === "command" ? `/${payload.command}${payload.args ? ` ${payload.args}` : ""}`
      : `[${payload.kind} 附件：${payload.attachment.mediaType}，第一版不做理解]`;

    // 标记 running 并落盘之后提交 Runtime：从这里崩溃 → 恢复标 unknown，
    // 绝不自动重跑（副作用可能已经发生）。
    record.state = "running";
    record.updatedAt = clock();
    await persist();

    let settlement: { state: "completed" | "cancelled" | "failed"; replyText?: string };
    try {
      settlement = await options.runtime.submit({
        conversationId: conversationOf(message),
        principalId,
        text,
        source: "text",
      });
    } catch (submitError) {
      record.state = "failed";
      record.note = submitError instanceof Error ? submitError.message.slice(0, 200) : "submit-error";
      record.updatedAt = clock();
      await persist();
      return;
    }

    if (settlement.state === "completed" && settlement.replyText) {
      const destination = {
        platform: message.platform, botAccount: message.botAccount,
        tenant: message.tenant, chatId: message.chatId,
        ...(message.threadId ? { threadId: message.threadId } : {}),
      };
      // 授权的原会话应答：固定按原目的地入队（会话策略内）。
      await enqueueReplyInternal({ inReplyToKey: record.key, destination, text: settlement.replyText });
    }
    record.state = settlement.state === "failed" ? "failed" : "completed";
    record.note = settlement.state === "failed" ? "runtime-failed" : undefined;
    record.updatedAt = clock();
    await persist();
  }

    async function enqueueReplyInternal(input: { inReplyToKey?: string; destination: OutboundMessageV1["destination"]; text: string }): Promise<{ ok: boolean; reason?: string }> {
    await ensureLoaded();
    if (outbox.size >= MAX_OUTBOX_PENDING) {
      return { ok: false, reason: "outbox-full" };
    }
    const outboundId = idFactory();
    const outbound: OutboundMessageV1 = {
      schemaVersion: 1,
      outboundId,
      ...(input.inReplyToKey ? { inReplyToKey: input.inReplyToKey } : {}),
      destination: { ...input.destination },
      text: input.text,
      state: "queued",
      attempts: 0,
      updatedAt: clock(),
    };
    outbox.set(outboundId, outbound);
    await persist();
    return { ok: true };
  }

  return {
    async ingest(message) {
      await ensureLoaded();
      if (message.schemaVersion !== 1) return { verdict: "rejected", reason: "unsupported-schema" };
      const invalid = validatePayload(message.payload);
      if (invalid) return { verdict: "rejected", reason: invalid };
      const key = inboxKeyOf(message);
      if (inbox.has(key)) return { verdict: "duplicate", key };

      const record: InboxRecordV1 = {
        schemaVersion: 1,
        key,
        message,
        // received：先持久接收——这一步落地之后才允许确认平台 offset。
        state: "received",
        receivedAt: message.receivedAt,
        updatedAt: clock(),
      };
      inbox.set(key, record);
      await persist();

      // 同会话串行链：保证到达顺序 = 提交顺序；跨会话链互不等待。
      const chainKey = `${message.platform}:${message.tenant}:${message.chatId}`;
      const previous = chains.get(chainKey) ?? Promise.resolve();
      const chain = previous
        .then(async () => {
          const current = inbox.get(key);
          if (!current || current.state !== "received") return;
          await processAccepted(current);
        })
        .catch(() => undefined);
      chains.set(chainKey, chain);
      return { verdict: "accepted", key, conversationId: conversationOf(message) };
    },

    async recover() {
      await ensureLoaded();
      let inboxUnknown = 0;
      const reprocess: InboxRecordV1[] = [];
      for (const record of inbox.values()) {
        if (record.state === "running") {
          // 已提交 Runtime 但没等到可确认的结果：unknown，绝不自动重跑。
          record.state = "unknown";
          record.note = "interrupted-before-settlement";
          record.updatedAt = clock();
          inboxUnknown += 1;
        } else if (record.state === "received") {
          // 还没提交过：安全地重新走处理链。
          reprocess.push(record);
        }
      }
      let outboxRequeued = 0;
      const now = clock();
      for (const outbound of [...outbox.values()]) {
        if (now - outbound.updatedAt > OUTBOX_TTL_MS) {
          outbox.delete(outbound.outboundId);
          continue;
        }
        if (outbound.state === "queued") {
          outboxRequeued += 1;
        }
      }
      await persist();
      // received 的重处理放逐会话链尾部，保持每会话有序。
      for (const record of reprocess) {
        const message = record.message;
        const chainKey = `${message.platform}:${message.tenant}:${message.chatId}`;
        const previous = chains.get(chainKey) ?? Promise.resolve();
        const chain = previous.then(async () => {
          const current = inbox.get(record.key);
          if (!current || current.state !== "received") return;
          await processAccepted(current);
        }).catch(() => undefined);
        chains.set(chainKey, chain);
      }
      return { inboxUnknown, outboxRequeued };
    },

    enqueueReply: enqueueReplyInternal,

    async flushOutbox() {
      await ensureLoaded();
      const result = { attempted: 0, sent: 0, failed: 0, unknown: 0 };
      const now = clock();
      for (const outbound of [...outbox.values()].sort((a, b) => a.updatedAt - b.updatedAt)) {
        if (outbound.state !== "queued") continue;
        if (outbound.nextAttemptAt !== undefined && outbound.nextAttemptAt > now) continue;
        if (outbound.attempts >= maxAttempts) {
          outbound.state = "failed";
          outbound.lastError = "retry-limit-reached";
          outbound.updatedAt = now;
          result.failed += 1;
          continue;
        }

        outbound.attempts += 1;
        result.attempted += 1;
        const delivery = await options.transport.send(outbound);
        if (delivery.outcome === "sent") {
          outbound.state = "sent";
          outbound.updatedAt = clock();
          result.sent += 1;
        } else if (delivery.outcome === "unknown") {
          // 发送结果不确认：只有平台声明支持幂等键才重试，否则 unknown 终态。
          if (options.transport.supportsIdempotentDelivery && outbound.attempts < maxAttempts) {
            outbound.state = "queued";
            outbound.nextAttemptAt = clock() + (delivery.retryAfterMs ?? 5_000);
            outbound.lastError = delivery.error ?? "delivery-unconfirmed";
          } else {
            outbound.state = "unknown";
            outbound.lastError = delivery.error ?? "delivery-unconfirmed";
            result.unknown += 1;
          }
        } else {
          const attemptsExhausted = outbound.attempts >= maxAttempts;
          outbound.state = attemptsExhausted ? "failed" : "queued";
          outbound.lastError = delivery.error ?? "delivery-failed";
          if (!attemptsExhausted) {
            outbound.nextAttemptAt = clock() + (delivery.retryAfterMs ?? 5_000);
          } else {
            result.failed += 1;
          }
        }
        outbound.updatedAt = clock();
        await persist();
      }
      return result;
    },

    inbox: async () => {
      await ensureLoaded();
      return [...inbox.values()];
    },

    outbox: async () => {
      await ensureLoaded();
      return [...outbox.values()];
    },
  };
}

function defaultIdFactory(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `out-${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`;
}
