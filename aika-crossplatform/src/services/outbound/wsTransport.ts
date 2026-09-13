/**
 * 浏览器 dev 传输适配（FE-16-A 的 TS 侧）。
 *
 * 把 Node dev-relay 的 WS 会话桥成 FE-14 的 `OutboundTransport`：
 * - 出站帧经 `{kind:"publish"}` 上行，relay 按 conversation 路由给订阅的 consumer。
 * - 入站命令经 `{kind:"command"}` 下行到达，relay 已带外注入服务端认定的 principal
 *   ——本适配不做认证，也不信任 body 身份（与 tauriTransport 同一边界）。
 *
 * 与 tauriTransport 的差别只在底座：这里用 WebSocket，生产构建不得启动连接。
 * 连接前提是「开发构建 + 显式本地 relay 配置」同时满足；仅 URL 参数不构成授权。
 */

import type { AuthenticatedCommand, AuthorizedTarget, OutboundFrameV1, OutboundTransport } from "./contracts";

/** WebSocket 的最小形状（避免依赖 DOM lib，便于 fake 与 Node 侧复用）。 */
export interface WsLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readyState: number;
  addEventListener(type: "open" | "message" | "close" | "error", handler: (event: unknown) => void): void;
  removeEventListener?(type: string, handler: (event: unknown) => void): void;
}

export interface WsTransportOptions {
  /** WS 工厂：接收带 ticket 的完整 URL。 */
  createSocket: (url: string) => WsLike;
  /** relay 基地址（已由配置层校验为本地 relay）。 */
  relayUrl: string;
  /** 单次 ticket（已在宿主侧认证后签发；不进 log）。 */
  ticket: string;
  /** 浏览器页面的 Origin，relay 回验用。 */
  origin?: string;
  /** 命令到达的回调注入点，便于测试。 */
  onDiagnostic?: (event: { kind: string; reason?: string }) => void;
}

interface PendingCommand {
  connectionId: string;
  conversationId: string;
  principal: { principalId: string };
  raw: unknown;
}

/**
 * 决定是否允许启动 dev relay 连接。
 * **仅当开发构建与显式配置同时满足**；生产构建无论 URL 参数如何都拒绝。
 */
export function shouldConnectDevRelay(input: {
  isDevBuild: boolean;
  configuredRelayUrl: string | null;
  urlParamRelay: string | null;
}): { allowed: boolean; relayUrl: string | null; reason?: "production-build" | "no-config" | "url-param-only" } {
  if (!input.isDevBuild) return { allowed: false, relayUrl: null, reason: "production-build" };
  // URL 参数不能替代显式配置：只给参数不给配置 = 拒绝。
  if (!input.configuredRelayUrl) {
    return {
      allowed: false,
      relayUrl: null,
      reason: input.urlParamRelay ? "url-param-only" : "no-config",
    };
  }
  return { allowed: true, relayUrl: input.configuredRelayUrl };
}

export function createWsOutboundTransport(
  options: WsTransportOptions,
): OutboundTransport & { ready(): Promise<void>; close(): void } {
  const commandHandlers: Array<(input: AuthenticatedCommand) => void> = [];
  let socket: WsLike | null = null;
  let started = false;
  const diagnostic = options.onDiagnostic ?? (() => undefined);

  function buildUrl(): string {
    const base = options.relayUrl.replace(/\/$/, "");
    const params = new URLSearchParams({ ticket: options.ticket });
    if (options.origin) params.set("origin", options.origin);
    return `${base}/?${params.toString()}`;
  }

  return {
    async ready() {
      if (started) return;
      started = true;
      const url = buildUrl();
      await new Promise<void>((resolve, reject) => {
        const ws = options.createSocket(url);
        socket = ws;
        let settled = false;
        ws.addEventListener("open", () => {
          if (settled) return;
          settled = true;
          resolve();
        });
        ws.addEventListener("message", (event) => {
          dispatchMessage(event);
        });
        ws.addEventListener("error", () => {
          diagnostic({ kind: "socket-error" });
          if (!settled) {
            settled = true;
            reject(new Error("dev relay 连接失败"));
          }
        });
        ws.addEventListener("close", () => {
          diagnostic({ kind: "socket-close" });
        });
      });
    },

    publish(_target: AuthorizedTarget, frame: OutboundFrameV1): void {
      if (!socket) return;
      // relay 按 frame.conversationId 路由；target 的 connectionId 由 relay 侧会话承担，
      // 浏览器侧无法也不应伪造连接身份。
      socket.send(JSON.stringify({ kind: "publish", frame }));
    },

    onCommand(handler) {
      commandHandlers.push(handler);
      return () => {
        const index = commandHandlers.indexOf(handler);
        if (index >= 0) commandHandlers.splice(index, 1);
      };
    },

    close() {
      socket?.close(1000, "client-close");
      socket = null;
    },
  };

  function dispatchMessage(event: unknown): void {
    const data = (event as { data?: unknown }).data;
    if (typeof data !== "string") return;
    let message: { kind?: string } & Record<string, unknown>;
    try {
      message = JSON.parse(data);
    } catch {
      diagnostic({ kind: "bad-json" });
      return;
    }
    if (message.kind === "command") {
      const command: AuthenticatedCommand = {
        raw: message.raw,
        principal: message.principal as AuthenticatedCommand["principal"],
        conversationId: String(message.conversationId),
        connectionId: String(message.connectionId),
      };
      for (const handler of [...commandHandlers]) {
        try {
          handler(command);
        } catch {
          // 一个监听者抛错不影响其它监听者（FE-14-G 隔离语义）。
        }
      }
      return;
    }
    if (message.kind === "rejected") {
      diagnostic({ kind: "rejected", reason: String(message.reason) });
    }
  }
}

/** 从 relay 下行 payload 解析命令（供测试与 fake relay 复用）。 */
export function parseRelayCommand(payload: unknown): PendingCommand | null {
  const message = payload as { kind?: string; raw?: unknown; connectionId?: unknown; conversationId?: unknown; principal?: unknown };
  if (!message || message.kind !== "command") return null;
  if (typeof message.connectionId !== "string" || typeof message.conversationId !== "string") return null;
  const principal = message.principal as { principalId?: unknown } | undefined;
  if (!principal || typeof principal.principalId !== "string") return null;
  return {
    connectionId: message.connectionId,
    conversationId: message.conversationId,
    principal: { principalId: principal.principalId },
    raw: message.raw,
  };
}
