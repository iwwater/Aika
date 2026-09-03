/**
 * 手机远程终端的数据形状。
 *
 * **手机不存任何东西，也不直接连模型**：记忆只有电脑上那一份，Key 也只在电脑上。
 * 所以这里只有「桌面端要交给手机看什么」这一件事，没有同步、没有合并。
 * 完整取舍见 DEVELOPMENT_PLAN 的 M7。
 */

import type { ChatMessage } from "./conversation";

/** 默认端口。挑一个不常被占的高位端口，用户可改。 */
export const REMOTE_DEFAULT_PORT = 8765;
/** token 的字节数。32 个十六进制字符，够长到不用担心被猜。 */
const TOKEN_BYTES = 16;

/** 手机上显示的一条消息。字段刻意比 ChatMessage 少：手机只是一块屏幕。 */
export interface RemoteMessage {
  role: "user" | "assistant";
  text: string;
  translation?: string;
  time: string;
  error?: boolean;
}

export interface RemoteMessagesPayload {
  /** 电脑上有没有配好模型。没配的话手机发过去也只会得到一条错误。 */
  connected: boolean;
  messages: RemoteMessage[];
}

/**
 * 生成访问口令。
 *
 * 局域网里的任何设备都能扫到这个端口，所以 token 不是形式：
 * 它是「同一个 WiFi 下的别人读不到她的记忆」的唯一保证。
 */
export function createRemoteToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** 端口必须是 1024 以上的整数：低位端口在 Windows 上要管理员权限。 */
export function normalizePort(value: unknown): number | null {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return null;
  return port;
}

/**
 * 还没答完的那一条不发给手机：手机没有流式通道，
 * 与其让它显示半句话，不如等这一轮完整了再出现。
 */
export function toRemoteMessages(messages: readonly ChatMessage[]): RemoteMessage[] {
  return messages
    .filter((message) => !message.pending)
    .map((message) => ({
      role: message.role,
      text: message.japaneseText ?? message.content,
      ...(message.chineseTranslation ? { translation: message.chineseTranslation } : {}),
      time: message.time,
      ...(message.error ? { error: true } : {}),
    }));
}

/** 取出手机发来的那句话。取不出来就返回空串，由调用方回一条明确的错误。 */
export function parseSendText(body: string): string {
  try {
    const payload = JSON.parse(body) as { text?: unknown };
    return typeof payload.text === "string" ? payload.text.trim() : "";
  } catch {
    return "";
  }
}
