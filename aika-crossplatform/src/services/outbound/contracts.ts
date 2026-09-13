/**
 * 远程协议内核契约（FE-14）。
 *
 * 出站三条铁律：
 * 1. **reply 是白名单投影**：replyText/translation/mood/受控展示动作——
 *    memoryCandidates、内部错误正文、sticker 之外的任何内部数据一律不投影。
 * 2. **目的地绑定**：turnId → 授权目标映射由提交时登记；未映射轮次不外发；
 *    桌面轮只能发给明确绑定该桌面 conversation 的设备。
 * 3. **cursor 单调**：gatewayEpoch 重启即换；过滤产生的序号空洞不是 gap。
 */

export const OUTBOUND_SCHEMA_VERSION = 1;
/** 远程命令文本上限（Unicode 码点）。 */
export const OUTBOUND_TEXT_MAX_CODEPOINTS = 4000;

export type OutboundChannel = "reply" | "status" | "trace";

export interface OutboundCursor {
  gatewayEpoch: string;
  seq: number;
}

/** 仅受控展示动作：类型 + 可选文案；无路径/脚本/参数。 */
export interface RemoteDisplayAction {
  readonly type: string;
  readonly label?: string;
}

export interface RemoteReplyV1 {
  replyText: string;
  translation: string | null;
  mood: string;
  actions: readonly RemoteDisplayAction[];
}

/** status 白名单：只有 code/状态/requestId，绝不原样输出 error.message。 */
export interface RemoteStatusV1 {
  code: string;
  state?: string;
  requestId?: string;
}

/** 远程 trace 投影：已经统一脱敏函数处理过的形状，默认无正文。 */
export interface RemoteTraceV1 {
  kind: string;
  turnId: string;
  seq: number;
  at: number;
}

export type OutboundFramePayload =
  | { channel: "reply"; reply: RemoteReplyV1 }
  | { channel: "status"; status: RemoteStatusV1 }
  | { channel: "trace"; trace: RemoteTraceV1 };

export interface OutboundFrameV1 {
  schemaVersion: 1;
  cursor: OutboundCursor;
  turnId?: string;
  conversationId?: string;
  payload: OutboundFramePayload;
}

export type OutboundCommandV1 =
  | { schemaVersion: 1; type: "submit"; messageId: string; text: string }
  | { schemaVersion: 1; type: "ping"; requestId: string };

/** transport 认证后带外注入的主体；不信任 body 里的任何身份声明。 */
export interface AuthenticatedPrincipal {
  principalId: string;
  displayName?: string;
}

export interface AuthenticatedCommand {
  raw: unknown;
  principal: AuthenticatedPrincipal;
  /** 从服务端会话映射，不信任 body 声明。 */
  conversationId: string;
  connectionId: string;
}

/** 授权目标：一条轮次/订阅允许到达的唯一身份三元组。 */
export interface AuthorizedTarget {
  connectionId: string;
  conversationId: string;
  principalId: string;
}

export interface OutboundTransport {
  publish(target: AuthorizedTarget, frame: OutboundFrameV1): void;
  onCommand(handler: (input: AuthenticatedCommand) => void): () => void;
}
