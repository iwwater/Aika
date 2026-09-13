/**
 * outboundDevRelay.mjs 的类型声明（FE-16）。
 * 脚本本体为纯 JS，不参与前端构建；此声明只服务 src 内测试与宿主装配的类型检查。
 */

export interface RelayStats {
  connectionsAccepted: number;
  connectionsRejected: number;
  framesPublished: number;
  framesDroppedByAuthorization: number;
  commandsReceived: number;
  slowConsumersDisconnected: number;
  revocationsApplied: number;
}

export interface RelayTicketInput {
  role: "producer" | "consumer";
  conversationId: string;
  principalId: string;
}

export interface RelayHandle {
  listen(): Promise<{ host: string; port: number; url: string }>;
  issueTicket(input: RelayTicketInput): { token: string; expiresAt: number };
  revokePrincipal(principalId: string): number;
  stats(): RelayStats;
  connectionCount(): number;
  close(): Promise<void>;
}

export interface RelayOptions {
  host?: string;
  port?: number;
  allowedOrigins: string[];
  clock?: () => number;
}

export const RELAY_MAX_MESSAGE_BYTES: number;
export const RELAY_MAX_MESSAGES_PER_SECOND: number;
export const RELAY_MAX_BUFFERED_FRAMES: number;
export const RELAY_TICKET_TTL_MS: number;
export const RELAY_CHANNELS: string[];

export class RelayError extends Error {
  code: string;
}

export function checkOrigin(origin: unknown, allowedOrigins: string[]): { ok: boolean; reason?: string };
export function isSlowConsumer(bufferedFrames: number): boolean;
export function takeRateToken(
  state: { tokens: number; lastRefill: number },
  now: number,
): { allowed: boolean; tokens: number; lastRefill: number };
export function createOutboundDevRelay(options: RelayOptions): RelayHandle;
