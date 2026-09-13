/**
 * Telegram 文本私聊适配（GW-02）——fixture 轨。
 *
 * 传输选官方 Bot API（getUpdates 长轮询 + sendMessage），协议依据
 * https://core.telegram.org/bots/api 。可靠性边界：
 *
 * - **token 在 URL 路径里**：任何日志/错误只允许出现方法名与状态码，
 *   `redactTelegramUrl` 把整段 token 换成 `<token>`（不能套用只删 query 的通用规则）。
 * - offset 只在 Gateway 持久接收之后推进（onMessage resolve 才算数）。
 * - 429 按 retry_after 等待；409（webhook 冲突）如实停止，**不自动 deleteWebhook**。
 * - 长文本按平台上限 4096 **码点**切分（不劈开代理对），切片 id 稳定可重查。
 *
 * 真实双向消息独立 NOT RUN：本模块在测试里只对着 fixture 与假 fetch 跑。
 */

import type { GatewayInboundMessageV1, GatewayPayload } from "../../domain/gateway";

export const TELEGRAM_TEXT_LIMIT = 4096;
export const TELEGRAM_BOT_API_BASE = "https://api.telegram.org";

/** 官方 update 结构（fixture 用）→ Gateway 入站消息；不认识的 update 返回 null。 */
export function parseTelegramUpdate(
  update: unknown,
  defaults: { botAccount: string; receivedAt?: number },
): GatewayInboundMessageV1 | null {
  if (!update || typeof update !== "object") return null;
  const raw = update as Record<string, unknown>;
  const msg = raw.message as Record<string, unknown> | undefined;
  if (!msg || typeof msg !== "object") return null;
  const messageId = String(msg.message_id ?? "");
  if (!messageId) return null;
  const chat = msg.chat as Record<string, unknown> | undefined ?? {};
  const from = msg.from as Record<string, unknown> | undefined ?? {};
  const chatType = String(chat.type ?? "private");
  const isGroup = chatType === "group" || chatType === "supergroup";

  let payload: GatewayPayload;
  if (typeof msg.text === "string" && msg.text.startsWith("/")) {
    const [command, rest] = msg.text.slice(1).split(/\s(.*)/, 2);
    payload = { kind: "command", command: command ?? "", ...(rest ? { args: rest } : {}) };
  } else if (typeof msg.text === "string") {
    payload = { kind: "text", text: msg.text };
  } else if (msg.voice && typeof msg.voice === "object") {
    const voice = msg.voice as Record<string, unknown>;
    payload = { kind: "voice", attachment: { attachmentId: String(voice.file_id ?? ""), mediaType: "audio/ogg", sizeBytes: Number(voice.file_size ?? 0) } };
  } else if (msg.photo || msg.document) {
    return null; // GW-03 处理；GW-02 只管文本私聊。
  } else {
    return null;
  }

  return {
    schemaVersion: 1,
    messageId,
    platform: "telegram",
    botAccount: defaults.botAccount,
    tenant: String(chat.id ?? ""),
    sender: String(from.id ?? ""),
    chatId: String(chat.id ?? ""),
    isGroup,
    receivedAt: defaults.receivedAt ?? Number(msg.date ?? 0) * 1000,
    payload,
  };
}

/** Unicode 安全切分：按码点切，代理对（emoji）不会被劈成半个。 */
export function splitTelegramText(text: string, limit = TELEGRAM_TEXT_LIMIT, messageId = "m"): { sliceId: string; text: string }[] {
  const points = Array.from(text);
  const slices: { sliceId: string; text: string }[] = [];
  let index = 0;
  while (index < points.length) {
    const chunk = points.slice(index, index + limit).join("");
    slices.push({ sliceId: `${messageId}#${slices.length}`, text: chunk });
    index += limit;
  }
  return slices.length ? slices : [{ sliceId: `${messageId}#0`, text: "" }];
}

/** token 在 URL 路径：整段替换，不是只删 query。 */
export function redactTelegramUrl(url: string): string {
  return url.replace(/\/bot[^/]+/, "/bot<token>");
}

export interface TelegramFetchResult {
  status: number;
  retryAfter?: number;
  body: unknown;
}

export interface TelegramApiCall {
  method: string;
  status: number;
  retryAfter?: number;
}

export interface TelegramTransportOptions {
  botToken: string;
  botAccount: string;
  fetchImpl: (url: string, init?: { signal?: AbortSignal; body?: string }) => Promise<TelegramFetchResult>;
  /** API 调用审计（已脱敏：只有方法名/状态码/retry-after）。 */
  onApiCall?: (call: TelegramApiCall) => void;
}

export function sendMessageUrl(botToken: string): string {
  return `${TELEGRAM_BOT_API_BASE}/bot${botToken}/sendMessage`;
}

export function getUpdatesUrl(botToken: string, offset: number, timeoutSec: number): string {
  return `${TELEGRAM_BOT_API_BASE}/bot${botToken}/getUpdates?offset=${offset}&timeout=${timeoutSec}`;
}

/** 发送一条（已切分的）切片；429 带 retry_after 返回给调用方决策。 */
export async function sendTelegramSlice(
  options: TelegramTransportOptions,
  chatId: string,
  text: string,
  signal?: AbortSignal,
): Promise<{ outcome: "sent" | "failed" | "unknown"; retryAfterMs?: number }> {
  const url = sendMessageUrl(options.botToken);
  try {
    const response = await options.fetchImpl(url, {
      signal,
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    options.onApiCall?.({ method: "sendMessage", status: response.status, retryAfter: response.retryAfter });
    if (response.status >= 200 && response.status < 300) return { outcome: "sent" };
    if (response.status === 429) {
      return { outcome: "failed", retryAfterMs: (response.retryAfter ?? 5) * 1000 };
    }
    return { outcome: "failed" };
  } catch (error) {
    // 请求中断/网络断：结果不确认——unknown，不是 failed。
    if (signal?.aborted) return { outcome: "unknown" };
    void error;
    return { outcome: "unknown" };
  }
}

export interface TelegramPollerOptions {
  botToken: string;
  botAccount: string;
  fetchImpl: (url: string, init?: { signal?: AbortSignal }) => Promise<{ status: number; retryAfter?: number; body: unknown }>;
  /** Gateway 的 ingest：resolve 之后 offset 才推进（GW-01 先持久接收）。 */
  onMessage: (message: GatewayInboundMessageV1) => Promise<void>;
  signal: AbortSignal;
  clock?: () => number;
  /** 假时钟驱动的等待注入；默认 setTimeout。 */
  sleep?: (ms: number) => Promise<void>;
  longPollTimeoutSec?: number;
}

export interface TelegramPoller {
  /** 阻塞直到 signal 中止；返回轮询到的 update 数（诊断）。 */
  run(): Promise<{ updates: number; conflict: boolean }>;
}

export function createTelegramPoller(options: TelegramPollerOptions): TelegramPoller {
  const clock = options.clock ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let offset = 0;
  let conflict = false;

  return {
    async run() {
      let updates = 0;
      while (!options.signal.aborted && !conflict) {
        const url = getUpdatesUrl(options.botToken, offset, options.longPollTimeoutSec ?? 25);
        let response: { status: number; retryAfter?: number; body: unknown };
        try {
          response = await options.fetchImpl(url, { signal: options.signal });
        } catch {
          if (options.signal.aborted) break;
          await sleep(5_000);
          continue;
        }
        if (options.signal.aborted) break;
        if (response.status === 409) {
          // webhook 冲突：如实停止，不自动 deleteWebhook（会影响别的部署）。
          conflict = true;
          break;
        }
        if (response.status === 429) {
          await sleep((response.retryAfter ?? 5) * 1000);
          continue;
        }
        if (response.status !== 200) {
          await sleep(5_000);
          continue;
        }
        const body = response.body as { result?: unknown[] } | null;
        const list = Array.isArray(body?.result) ? (body?.result as unknown[]) : [];
        for (const update of list) {
          const updateId = typeof (update as Record<string, unknown>).update_id === "number"
            ? (update as Record<string, unknown>).update_id as number
            : null;
          const message = parseTelegramUpdate(update, { botAccount: options.botAccount, receivedAt: clock() });
          if (!message) {
            // 不认识的 update 也要推进 offset，否则会永远卡在它上面。
            if (updateId !== null && updateId >= offset) offset = updateId + 1;
            continue;
          }
          // 先持久接收（onMessage 内部完成 inbox 落地），再推进 offset。
          await options.onMessage(message);
          updates += 1;
          if (updateId !== null && updateId >= offset) offset = updateId + 1;
        }
      }
      return { updates, conflict };
    },
  };
}
