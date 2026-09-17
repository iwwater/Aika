export type WeChatReplyMode = 'follow_input' | 'text' | 'voice';
export type WeChatInputSource = 'text' | 'voice';
/** Local authenticated management API, v0.2. Credentials never enter this snapshot. */
export interface WeChatSnapshot {
  apiVersion: '0.2';
  /** Persistent setting, frozen with message source before processing. */
  replyMode: WeChatReplyMode;
  revision: number;
  status: 'disconnected' | 'starting' | 'waiting_scan' | 'scanned' | 'need_verification' | 'connected' | 'paused' | 'expired' | 'error';
  enabled: boolean;
  boundUser: { userId: string; botId: string } | null;
  detail: string;
  /** Ephemeral; no logs, screenshots, browser storage, downloads or remote QR renderer. */
  qr: { imageDataUrl: string; expiresAt: string } | null;
  lastInputAt: string | null;
  lastOutputAt: string | null;
  lastDelivery: 'none' | 'accepted' | 'unknown' | 'failed';
}
export type WeChatAction = { action: 'set_reply_mode'; replyMode: WeChatReplyMode; expectedRevision: number } | { action: 'login' | 'start' | 'stop' | 'disconnect'; expectedRevision: number }
  | { action: 'verify'; expectedRevision: number; code: string };
export interface WeChatManagement {
  snapshot(): WeChatSnapshot;
  action(input: WeChatAction): Promise<WeChatSnapshot>;
}
// GET /api/wechat -> snapshot. POST /api/wechat + action -> snapshot.
// Existing loopback Bearer/origin protections apply. POST conflict -> 409; re-read GET.
// Poll visible page every 2s; ignore snapshots older than the highest rendered revision.
// QR uses the server-generated imageDataUrl. Verification code is cleared after submit.
