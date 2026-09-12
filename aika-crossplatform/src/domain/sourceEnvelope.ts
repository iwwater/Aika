/**
 * 可信来源信封（RT-01）。
 *
 * 外部入口（桌面/手机/Telegram/Agent…）带来的每一次提交都要有一个信封：
 * 谁发的、在哪个账户、哪段会话、哪条消息、什么时候、凭什么可信。
 *
 * 三条不可退让的边界：
 * 1. **不覆盖既有 TurnSource 语义**。旧 `text/voice/proactive` 是本地编排的来源
 *    标记，继续原样存在；信封是外部入口的第二条正交通道。
 * 2. **trust 只能由认证端口生成**。`authenticated` 携带一个不导出的 brand，
 *    本模块之外在类型上就构造不出来——`local` 与 `unverified` 是诚实的等级，
 *    不是降级版的 authenticated。
 * 3. **历史来源 unknown 不获得权限**。旧消息没有信封，映射一律 unknown，
 *    绝不伪造账户归属。
 */

export const SOURCE_ENVELOPE_SCHEMA_VERSION = 1;

export type SourceOrigin =
  | "desktop"
  | "mobile"
  | "telegram"
  | "feishu"
  | "qq"
  | "environment"
  | "agent"
  | "unknown";

/** `authenticated` 的 brand：类型不导出，外部模块构造不出这个变体。 */
declare const AUTHENTICATED_BRAND: unique symbol;

export interface AuthenticatedTrust {
  kind: "authenticated";
  /** 已认证的主体 id（认证端口在验证后填入）。 */
  principalId: string;
  [AUTHENTICATED_BRAND]: true;
}

export type SourceTrust =
  | AuthenticatedTrust
  /** 本地主体：桌面/本机入口，没有跨网络认证语义。 */
  | { kind: "local" }
  /** 未经认证：default-deny，任何权限检查都应拒绝（RT-03）。 */
  | { kind: "unverified" };

/** 本地桌面的信任等级：它可信是因为「在本机上」，不是因为「认证过」。 */
export function localTrust(): SourceTrust {
  return { kind: "local" };
}

export function unverifiedTrust(): SourceTrust {
  return { kind: "unverified" };
}

export interface SourceEnvelope {
  version: 1;
  principalId: string;
  accountRef: string;
  conversationId: string;
  /** 会话内的串行线程；单线程入口省略。 */
  threadId?: string;
  origin: SourceOrigin;
  /** 入口侧的消息标识：幂等去重的输入之一。 */
  messageId: string;
  receivedAt: number;
  trust: SourceTrust;
}

/** 消息幂等键：同一入口的同一 messageId 只处理一次。 */
export function messageDedupeKey(envelope: Pick<SourceEnvelope, "origin" | "accountRef" | "messageId">): string {
  return `${envelope.origin}:${envelope.accountRef}:${envelope.messageId}`;
}

/** 旧 TurnSource → 信封 origin 的兼容映射；旧值语义不变，只加映射不改名。 */
export function legacySourceOrigin(source: "text" | "voice" | "proactive"): SourceOrigin {
  return source === "proactive" ? "environment" : "desktop";
}

export interface DesktopEnvelopeInput {
  /** 本地主conversationId：单主体桌面的稳定默认。 */
  conversationId?: string;
  /** 本地提交内的消息标识；没有就由调用方给 uuid。 */
  messageId: string;
  receivedAt: number;
}

/**
 * 桌面兼容适配：把旧的本地提交包成信封。principalId/accountRef 都映射到
 * **本地主体**——桌面轮是 local 信任、本地归属，不假装有账户体系。
 */
export function desktopEnvelope(input: DesktopEnvelopeInput): SourceEnvelope {
  return {
    version: SOURCE_ENVELOPE_SCHEMA_VERSION,
    principalId: "local",
    accountRef: "local",
    conversationId: input.conversationId ?? "local",
    origin: "desktop",
    messageId: input.messageId,
    receivedAt: input.receivedAt,
    trust: localTrust(),
  };
}

/**
 * 历史消息的信封投影：旧消息没有信封，origin 一律 unknown、trust unverified、
 * 账户归属留空字符串而不是编一个。RT-02/RT-03 据此 default-deny。
 */
export function unknownEnvelopeForLegacy(receivedAt: number): SourceEnvelope {
  return {
    version: SOURCE_ENVELOPE_SCHEMA_VERSION,
    principalId: "",
    accountRef: "",
    conversationId: "local",
    origin: "unknown",
    messageId: "",
    receivedAt,
    trust: unverifiedTrust(),
  };
}
