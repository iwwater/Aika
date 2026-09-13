/**
 * QQ 官方平台适配（GW-06）——fixture 轨。
 *
 * **先验证平台可行性**（全文审阅）：QQ 开放平台机器人（q.qq.com）官方能力表——
 * 仅支持**群聊 @ 机器人**与**频道**场景为主，C2C 私聊需申请且受审核条件约束；
 * 文件/语音收发能力按官方文档为受限白名单。**不使用账号逆向协议补齐能力，
 * 不擅自用其他账号形态替代「个人 QQ 私聊」**——能力不足的差异如实列在
 * `QQ_CAPABILITY_GAPS`，整项保留条件阻塞（GW-06-D）。
 *
 * 本地 adapter 只实现确定支持的文本 scope（群 @ 文本、官方 C2C 文本若已开通），
 * 精确命名该范围；未支持能力明确拒绝。
 */

import type { GatewayInboundMessageV1 } from "../../domain/gateway";

/** 官方能力快照与差异（GW-06-D）：接入前依据 QQ 开放平台文档核实。 */
export const QQ_CAPABILITY_GAPS: readonly string[] = [
  "C2C 私聊需开放平台申请且受审核条件约束——未开通时不可用",
  "文件/语音收发为受限白名单能力——本适配不支持",
  "个人 QQ 私聊（非开放平台机器人）不在官方能力范围",
];

export type QqScope = "group@-text" | "c2c-text";

/** 精确命名支持的文本 scope（AGT/GW 契约：不冒充达到原场景）。 */
export const QQ_SUPPORTED_SCOPES: readonly QqScope[] = ["group@-text", "c2c-text"];

export interface QqEventEnvelope {
  /** 官方 webhook payload：op 字段区分生命周期/事件。 */
  op: number;
  t?: string;
  d?: Record<string, unknown>;
}

/** 官方 C2C_AT_MESSAGE_CREATE / GROUP_AT_MESSAGE_CREATE 事件 → 入站消息。 */
export function parseQqMessage(
  envelope: QqEventEnvelope,
  options: { botAccount: string; allowedScopes: readonly QqScope[] },
): { ok: true; message: GatewayInboundMessageV1 } | { ok: false; reason: string } {
  if (envelope.op !== 0 || !envelope.t || !envelope.d) {
    return { ok: false, reason: `unsupported-op:${envelope.op}` };
  }
  const data = envelope.d;
  const messageType = String(data.content ?? "");
  const id = String(data.id ?? "");
  const author = (data.author as Record<string, unknown> | undefined)?.user_openid
    ?? (data.author as Record<string, unknown> | undefined)?.id;
  const groupOpenid = data.group_openid as string | undefined;
  if (!id || !author) return { ok: false, reason: "missing-ids" };

  let scope: QqScope;
  let chatId: string;
  let isGroup: boolean;
  if (envelope.t === "GROUP_AT_MESSAGE_CREATE" && groupOpenid) {
    scope = "group@-text";
    chatId = groupOpenid;
    isGroup = true;
  } else if (envelope.t === "C2C_AT_MESSAGE_CREATE") {
    scope = "c2c-text";
    chatId = String(author);
    isGroup = false;
  } else {
    return { ok: false, reason: `unsupported-event:${envelope.t}` };
  }
  if (!options.allowedScopes.includes(scope)) {
    return { ok: false, reason: `scope-not-supported:${scope}` };
  }
  if (!messageType.trim()) return { ok: false, reason: "empty-text" };

  return {
    ok: true,
    message: {
      schemaVersion: 1,
      messageId: id,
      platform: "qq",
      botAccount: options.botAccount,
      tenant: groupOpenid ?? "qq-official",
      sender: String(author),
      chatId,
      isGroup,
      receivedAt: Date.now(),
      payload: { kind: "text", text: messageType },
    },
  };
}

/** 平台限流负例：QQ 官方限流响应 → 显式 retry-after。 */
export function qqRateLimitVerdict(status: number, body: { retry_after?: number }): { retryAfterMs?: number; failed: boolean } {
  if (status === 429) {
    return { retryAfterMs: (body.retry_after ?? 5) * 1000, failed: false };
  }
  return { failed: status >= 400 };
}
