/**
 * Channel Gateway 契约（GW-01）。
 *
 * 版本化判别联合的入站消息（text/voice/image/file/command）、持久化 inbox
 * （received/accepted/running/completed/failed/unknown）与 outbox
 * （queued/sent/failed/unknown）。可靠性边界必须如实：
 *
 * - inbox 持久唯一键 = 平台账户+会话+messageId；先持久接收再确认平台 offset。
 * - 提交 Runtime 后崩溃、没有可查询的幂等结果 → 标 unknown，**不自动再次调用**
 *   ——我们不承诺 exactly-once。
 * - outbox 送达不确认（断线）→ unknown；除非平台支持相同幂等键，不盲目重试。
 * - 目的地绑定原请求：LLM 正文不能改收件人。
 * - 第一版不做图像理解：image 只作为附件表示或明确 unsupported。
 */

export const GATEWAY_SCHEMA_VERSION = 1;

export type GatewayPayloadKind = "text" | "voice" | "image" | "file" | "command";

export interface GatewayAttachmentRef {
  attachmentId: string;
  /** IANA media type；未知类型在入口校验被拒。 */
  mediaType: string;
  sizeBytes: number;
}

export type GatewayPayload =
  | { kind: "text"; text: string }
  | { kind: "voice"; attachment: GatewayAttachmentRef }
  | { kind: "image"; attachment: GatewayAttachmentRef }
  | { kind: "file"; attachment: GatewayAttachmentRef }
  | { kind: "command"; command: string; args?: string };

export interface GatewayInboundMessageV1 {
  schemaVersion: 1;
  /** 平台消息 id：幂等去重的输入之一。 */
  messageId: string;
  platform: string;
  botAccount: string;
  tenant: string;
  sender: string;
  chatId: string;
  threadId?: string;
  isGroup: boolean;
  receivedAt: number;
  payload: GatewayPayload;
}

/** inbox 持久唯一键（GW-01：平台账户+会话+messageId）。 */
export function inboxKeyOf(message: Pick<GatewayInboundMessageV1, "platform" | "botAccount" | "tenant" | "chatId" | "messageId">): string {
  return [message.platform, message.botAccount, message.tenant, message.chatId, message.messageId]
    .map((part) => encodeURIComponent(part))
    .join(":");
}

export type InboxState = "received" | "accepted" | "running" | "completed" | "failed" | "unknown";

export interface InboxRecordV1 {
  schemaVersion: 1;
  key: string;
  message: GatewayInboundMessageV1;
  state: InboxState;
  receivedAt: number;
  updatedAt: number;
  /** runtime 轮次 id（completed/running 时可查）。 */
  runtimeTurnId?: string;
  note?: string;
}

/** 附件入口校验：未知类型拒绝、超限拒绝（GW-01-B）。 */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/** 第一版可受理的附件类型：语音可转写，其余只作附件表示，不做理解。 */
const ACCEPTED_MEDIA_TYPES: readonly string[] = [
  "audio/", "application/ogg", "application/pdf", "text/plain",
];

export function validatePayload(payload: GatewayPayload): string | null {
  switch (payload.kind) {
    case "text":
      return payload.text.trim() ? null : "text 为空";
    case "command":
      return payload.command.trim() ? null : "command 为空";
    case "voice":
    case "image":
    case "file": {
      const attachment = payload.attachment;
      if (!attachment.attachmentId.trim()) return "缺少附件 id";
      if (!Number.isFinite(attachment.sizeBytes) || attachment.sizeBytes <= 0) return "附件大小非法";
      if (attachment.sizeBytes > MAX_ATTACHMENT_BYTES) return "附件超过大小上限";
      const media = attachment.mediaType.toLowerCase();
      const accepted = ACCEPTED_MEDIA_TYPES.some((prefix) => media.startsWith(prefix));
      if (!accepted) return `不支持的附件类型：${attachment.mediaType}`;
      return null;
    }
    default:
      return "未知消息类型";
  }
}

export type OutboxState = "queued" | "sent" | "failed" | "unknown";

/** 目的地固定绑定原请求：出站消息创建后不可改收件人。 */
export interface OutboundDestinationV1 {
  platform: string;
  botAccount: string;
  tenant: string;
  chatId: string;
  threadId?: string;
}

export interface OutboundMessageV1 {
  schemaVersion: 1;
  outboundId: string;
  /** 回复原消息；新目标（未授权会话之外）不允许自动发送。 */
  inReplyToKey?: string;
  destination: OutboundDestinationV1;
  /** 白名单投影后的应答文本/状态，不含原始 LLM 结构与内部错误细节。 */
  text: string;
  state: OutboxState;
  attempts: number;
  nextAttemptAt?: number;
  lastError?: string;
  updatedAt: number;
}

/** 重试次数上限（可配置更低，不可更高）。 */
export const MAX_OUTBOUND_ATTEMPTS = 3;
/** outbox 容量与 TTL：有界，超限拒收/淘汰。 */
export const MAX_OUTBOX_PENDING = 200;
export const OUTBOX_TTL_MS = 24 * 60 * 60_000;
