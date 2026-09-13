/**
 * Feishu/Lark 平台适配（GW-05）——fixture 轨。
 *
 * 官方能力快照（依据飞书开放平台文档，接入前已核实）：开放域名 open.feishu.cn
 * / open.larksuite.com；身份为 tenant_key + open_id/user_id；文本 DM 支持事件
 * 回调（im.message.receive_v1）；tenant_access_token 需刷新；有限流；事件订阅
 * 默认使用长连接/回调——**默认不开公网 webhook**，若选择 webhook 必须实现
 * 验签+解密+重放窗口并列入真实部署门禁。
 *
 * 本模块只做：事件信封验签/重放防御/tenant 隔离 → GW-01 入站消息；文本私聊
 * 最小交付；token 刷新失败可见且不泄漏。语音/文件/群功能未支持 → 明确拒绝。
 */

import type { GatewayInboundMessageV1 } from "../../domain/gateway";
import { createHash } from "node:crypto";

export const FEISHU_REPLAY_WINDOW_MS = 5 * 60_000;

/** 事件信封验签 + 重放防御 + tenant 隔离（GW-05-B）。 */
export interface FeishuEventEnvelope {
  schema: string;
  header?: {
    event_id?: string;
    event_type?: string;
    tenant_key?: string;
    create_time?: number;
  };
  event?: Record<string, unknown>;
  /** url_verification challenge（真实部署门禁使用；fixture 轨仅识别）。 */
  type?: string;
  challenge?: string;
}

export function verifyFeishuSignature(input: {
  payload: string;
  signature: string;
  timestamp: number | string;
  encryptKey: string;
}): boolean {
  const expected = createHash("sha256")
    .update(`${input.timestamp}${input.payload}${input.encryptKey}`)
    .digest("hex");
  return expected === input.signature;
}

export interface FeishuVerifyInput {
  envelope: FeishuEventEnvelope;
  signature: string;
  timestamp: number;
  encryptKey: string;
  allowedTenants: readonly string[];
  seenEventIds: Set<string>;
  now: number;
}

export function verifyFeishuEvent(input: FeishuVerifyInput): { ok: true } | { ok: false; reason: "bad-signature" | "replayed" | "stale" | "unknown-tenant" | "missing-event-id" } {
  // 验签。
  const payload = JSON.stringify(input.envelope);
  const expected = createHash("sha256")
    .update(`${input.timestamp}${payload}${input.encryptKey}`)
    .digest("hex");
  if (expected !== input.signature) return { ok: false, reason: "bad-signature" };
  // 重放窗口：事件 id 重复或时间过旧。
  const eventId = input.envelope.header?.event_id;
  if (!eventId) return { ok: false, reason: "missing-event-id" };
  if (input.seenEventIds.has(eventId)) return { ok: false, reason: "replayed" };
  // create_time 官方为秒级时间戳：归一到毫秒再比窗口。
  const rawCreateTime = input.envelope.header?.create_time ?? 0;
  const createTimeMs = rawCreateTime > 1e12 ? rawCreateTime : rawCreateTime * 1000;
  if (input.now - createTimeMs > FEISHU_REPLAY_WINDOW_MS) return { ok: false, reason: "stale" };
  // tenant 隔离。
  const tenantKey = input.envelope.header?.tenant_key;
  if (!tenantKey || !input.allowedTenants.includes(tenantKey)) {
    return { ok: false, reason: "unknown-tenant" };
  }
  input.seenEventIds.add(eventId);
  return { ok: true };
}

export interface FeishuParseOptions {
  botAccount: string;
  /** 只接受这些 tenant_key（跨 tenant 隔离）。 */
  allowedTenants: readonly string[];
  /** 只接受已绑定的 open_id 私聊（最小交付）。 */
  boundOpenIds: readonly string[];
}

/**
 * 官方 im.message.receive_v1 事件 → GW-01 入站消息。
 * 群聊/非文本 → 明确拒绝（最小交付仅已绑定私聊文本，GW-05 全文审阅）。
 */
export function parseFeishuMessage(
  envelope: FeishuEventEnvelope,
  options: FeishuParseOptions,
): { ok: true; message: GatewayInboundMessageV1 } | { ok: false; reason: string } {
  const tenantKey = String(envelope.header?.tenant_key ?? "");
  if (!options.allowedTenants.includes(tenantKey)) {
    return { ok: false, reason: "unknown-tenant" };
  }
  const event = envelope.event ?? {};
  const message = event.message as Record<string, unknown> | undefined;
  if (!message || typeof message !== "object") return { ok: false, reason: "missing-message" };
  const sender = (event.sender as Record<string, unknown> | undefined)?.sender_id as Record<string, unknown> | undefined;
  const openId = String(sender?.open_id ?? "");
  const chatType = String(message?.chat_type ?? "");
  const messageId = String(message?.message_id ?? "");
  if (!messageId) return { ok: false, reason: "missing-message-id" };
  if (chatType !== "p2p") return { ok: false, reason: "group-not-supported" };
  if (!options.boundOpenIds.includes(openId)) return { ok: false, reason: "sender-not-bound" };
  const messageType = String(message?.message_type ?? "");
  if (messageType !== "text") return { ok: false, reason: `unsupported-message-type:${messageType}` };
  let text = "";
  try {
    const content = JSON.parse(String(message.content ?? "{}")) as { text?: string };
    text = content.text ?? "";
  } catch {
    return { ok: false, reason: "malformed-content" };
  }
  if (!text.trim()) return { ok: false, reason: "empty-text" };

  return {
    ok: true,
    message: {
      schemaVersion: 1,
      messageId,
      platform: "feishu",
      botAccount: options.botAccount,
      tenant: tenantKey,
      sender: openId,
      chatId: String(message.chat_id ?? openId),
      isGroup: false,
      receivedAt: Number(envelope.header?.create_time ?? Date.now() / 1000) * 1000,
      payload: { kind: "text", text },
    },
  };
}

/** token 刷新：失败可见且不泄漏（错误只带状态码，token 永不进日志/错误）。 */
export interface FeishuTokenManager {
  getToken(): Promise<string>;
  lastRefreshError(): string | null;
}

export function createFeishuTokenManager(input: {
  fetchImpl: (url: string, body: string) => Promise<{ status: number; body: { tenant_access_token?: string; expire?: number } }>;
  appId: string;
  appSecret: string;
  clock?: () => number;
}): FeishuTokenManager {
  let cached: { token: string; expiresAt: number } | null = null;
  let lastError: string | null = null;
  const clock = input.clock ?? (() => Date.now());
  return {
    async getToken() {
      if (cached && cached.expiresAt > clock() + 60_000) {
        lastError = null;
        return cached.token;
      }
      const response = await input.fetchImpl(
        "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
        JSON.stringify({ app_id: input.appId, app_secret: input.appSecret }),
      );
      if (response.status !== 200 || !response.body.tenant_access_token) {
        // 只暴露状态码；响应体与 token 段不进错误。
        lastError = `token-refresh-failed:${response.status}`;
        throw new Error(lastError);
      }
      cached = {
        token: response.body.tenant_access_token,
        expiresAt: clock() + (response.body.expire ?? 3600) * 1000,
      };
      lastError = null;
      return cached.token;
    },
    lastRefreshError: () => lastError,
  };
}
