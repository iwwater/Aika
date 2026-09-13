/**
 * 浏览器 dev 传输的 Node WS 中继（FE-16 生产 relay）。
 *
 * 定位：**开发期**给浏览器页面提供与桌面 Tauri 宿主等价的 outbound 传输。
 * 生产构建 + URL 参数不能启动它——只有开发构建 + 显式本地配置同时满足才连。
 *
 * 三条铁律（与 FE-14/FE-16 SPEC 对齐）：
 * 1. **只监听 loopback**：默认 127.0.0.1，LAN/public 需显式配置且 public 恒拒。
 * 2. **角色分离**：producer（页面 Runtime 出站帧）/ consumer（外部设备命令）
 *    用不同 ticket 认证；consumer 不能 publish，producer 不能替主体创建审批。
 * 3. **不持 LLM 凭证、不调 Provider**：中继只做字节路由，业务语义全在两端。
 *
 * 授权与 cursor 语义复用 FE-14：帧按连接过滤、按 conversation 订阅、
 * 慢消费者断开并保留可重连状态；断线只恢复事件游标，不自动重发状态未知的 submit。
 */

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";

/** 单条 WS 消息字节上限。 */
export const RELAY_MAX_MESSAGE_BYTES = 256 * 1024;
/** 每连接每秒消息上限（令牌桶容量）。 */
export const RELAY_MAX_MESSAGES_PER_SECOND = 60;
/** 单连接缓冲帧上限；超出判慢消费者并断开。 */
export const RELAY_MAX_BUFFERED_FRAMES = 500;
/** ticket 单次使用 TTL。 */
export const RELAY_TICKET_TTL_MS = 30_000;
/** 订阅频道白名单。 */
export const RELAY_CHANNELS = ["reply", "status", "trace"];

export class RelayError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** 校验 Origin：只允许显式配置的来源；缺失 Origin（非浏览器）不自动放行。 */
export function checkOrigin(origin, allowedOrigins) {
  if (typeof origin !== "string" || !origin.trim()) {
    return { ok: false, reason: "missing-origin" };
  }
  if (!allowedOrigins.includes(origin)) {
    return { ok: false, reason: "bad-origin" };
  }
  return { ok: true };
}

/** 纯函数：判定是否慢消费者。 */
export function isSlowConsumer(bufferedFrames) {
  return bufferedFrames > RELAY_MAX_BUFFERED_FRAMES;
}

/** 纯函数：令牌桶取令。返回 { allowed, tokens }。 */
export function takeRateToken(state, now) {
  const elapsed = now - state.lastRefill;
  const refill = (elapsed / 1000) * RELAY_MAX_MESSAGES_PER_SECOND;
  const tokens = Math.min(RELAY_MAX_MESSAGES_PER_SECOND, state.tokens + refill);
  if (tokens < 1) {
    return { allowed: false, tokens, lastRefill: now };
  }
  return { allowed: true, tokens: tokens - 1, lastRefill: now };
}

/**
 * 创建 relay。返回 { server, wss, url, listen, close, issueTicket, revokeTicket,
 * publish, stats, connectionCount }。
 *
 * @param {object} options
 * @param {string} [options.host] 绑定地址，默认 127.0.0.1（loopback）。
 * @param {number} [options.port] 端口；0 = 随机可用端口（测试用）。
 * @param {string[]} options.allowedOrigins 允许的 Origin 白名单。
 * @param {() => number} [options.clock]
 */
export function createOutboundDevRelay(options) {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  const allowedOrigins = options.allowedOrigins ?? [];
  const clock = options.clock ?? (() => Date.now());

  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new RelayError("non-loopback-bind", `relay 只允许绑定 loopback，收到 ${host}`);
  }

  /** ticket 表：token → { role, connectionId, conversationId, principalId, expiresAt, used } */
  const tickets = new Map();
  /** 活跃连接：connectionId → connection 记录 */
  const connections = new Map();
  /** conversationId → Set<connectionId>（订阅关系） */
  const subscriptions = new Map();

  const stats = {
    connectionsAccepted: 0,
    connectionsRejected: 0,
    framesPublished: 0,
    framesDroppedByAuthorization: 0,
    commandsReceived: 0,
    slowConsumersDisconnected: 0,
    revocationsApplied: 0,
  };

  const httpServer = createServer((req, res) => {
    // relay 不提供任何 HTTP 资源；非 WS 升级一律 404，避免被扫成 API。
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("outbound dev relay");
  });

  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req, socket) => {
    const originCheck = checkOrigin(req.headers.origin, allowedOrigins);
    if (!originCheck.ok) {
      stats.connectionsRejected += 1;
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, Buffer.alloc(0), (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws, req) => {
    // ticket 从 query 取；长期凭证不进 URL，ticket 单次使用且短期有效。
    const url = new URL(req.url ?? "/", `http://${host}`);
    const ticketToken = url.searchParams.get("ticket");
    const verdict = consumeTicket(ticketToken);
    if (!verdict.ok) {
      stats.connectionsRejected += 1;
      ws.close(4401, verdict.reason);
      return;
    }

    const { role, conversationId, principalId } = verdict.record;
    const connectionId = randomUUID();
    const connection = {
      connectionId,
      role,
      conversationId,
      principalId,
      ws,
      rate: { tokens: RELAY_MAX_MESSAGES_PER_SECOND, lastRefill: clock() },
      bufferedFrames: 0,
      closed: false,
    };
    connections.set(connectionId, connection);
    stats.connectionsAccepted += 1;

    if (role === "consumer") {
      subscribe(connectionId, conversationId);
    }

    ws.on("message", (data) => {
      handleIncoming(connection, data);
    });
    ws.on("close", () => {
      connection.closed = true;
      connections.delete(connectionId);
      unsubscribe(connectionId);
    });
    ws.on("error", () => {
      connection.closed = true;
      connections.delete(connectionId);
      unsubscribe(connectionId);
    });

    // 连接就绪回执：告知本连接被分配的 id 与角色，便于客户端定位。
    safeSend(ws, {
      kind: "ready",
      connectionId,
      role,
      conversationId,
      maxMessageBytes: RELAY_MAX_MESSAGE_BYTES,
    });
  });

  function consumeTicket(token) {
    if (typeof token !== "string" || !token.trim()) {
      return { ok: false, reason: "missing-ticket" };
    }
    const record = tickets.get(token);
    if (!record) return { ok: false, reason: "unknown-ticket" };
    if (record.used) return { ok: false, reason: "ticket-reused" };
    if (clock() > record.expiresAt) return { ok: false, reason: "ticket-expired" };
    // 原子单次消费：标记与后续之间没有 await。
    record.used = true;
    return { ok: true, record };
  }

  function subscribe(connectionId, conversationId) {
    let set = subscriptions.get(conversationId);
    if (!set) {
      set = new Set();
      subscriptions.set(conversationId, set);
    }
    set.add(connectionId);
  }

  function unsubscribe(connectionId) {
    for (const set of subscriptions.values()) set.delete(connectionId);
  }

  function safeSend(ws, payload) {
    try {
      ws.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  function handleIncoming(connection, data) {
    const rate = takeRateToken(connection.rate, clock());
    connection.rate = { tokens: rate.tokens, lastRefill: rate.lastRefill };
    if (!rate.allowed) {
      closeSlow(connection, "rate-limit");
      return;
    }

    const size = typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
    if (size > RELAY_MAX_MESSAGE_BYTES) {
      closeSlow(connection, "message-too-large");
      return;
    }

    let message;
    try {
      message = JSON.parse(typeof data === "string" ? data : data.toString("utf8"));
    } catch {
      safeSend(connection.ws, { kind: "rejected", reason: "invalid-json" });
      return;
    }

    if (message?.kind === "publish") {
      // 只有 producer 能发布 Runtime 帧；consumer 伪造 publish 一律拒绝。
      if (connection.role !== "producer") {
        stats.framesDroppedByAuthorization += 1;
        safeSend(connection.ws, { kind: "rejected", reason: "consumer-cannot-publish" });
        return;
      }
      routeFrame(message);
      return;
    }

    if (message?.kind === "subscribe") {
      if (connection.role !== "consumer") {
        safeSend(connection.ws, { kind: "rejected", reason: "producer-cannot-subscribe" });
        return;
      }
      if (typeof message.conversationId !== "string" || !message.conversationId.trim()) {
        safeSend(connection.ws, { kind: "rejected", reason: "bad-conversation" });
        return;
      }
      // 会话隔离：consumer 只能订阅自己 ticket 绑定的 conversation。
      if (message.conversationId !== connection.conversationId) {
        safeSend(connection.ws, { kind: "rejected", reason: "conversation-not-permitted" });
        return;
      }
      subscribe(connection.connectionId, message.conversationId);
      safeSend(connection.ws, { kind: "subscribed", conversationId: message.conversationId });
      return;
    }

    if (message?.kind === "command") {
      // consumer → producer 上行；relay 只转发并带上服务端认定的身份。
      if (connection.role !== "consumer") {
        safeSend(connection.ws, { kind: "rejected", reason: "producer-cannot-command" });
        return;
      }
      stats.commandsReceived += 1;
      routeCommand(connection, message);
      return;
    }

    safeSend(connection.ws, { kind: "rejected", reason: "unknown-kind" });
  }

  /** 出站帧按 conversation 路由给订阅的 consumer。 */
  function routeFrame(message) {
    const conversationId = message?.frame?.conversationId;
    if (typeof conversationId !== "string") {
      stats.framesDroppedByAuthorization += 1;
      return;
    }
    const set = subscriptions.get(conversationId);
    if (!set || set.size === 0) return;
    const payload = JSON.stringify({ kind: "frame", frame: message.frame });
    for (const connectionId of set) {
      const connection = connections.get(connectionId);
      if (!connection || connection.closed) continue;
      connection.bufferedFrames += 1;
      if (isSlowConsumer(connection.bufferedFrames)) {
        closeSlow(connection, "slow-consumer");
        continue;
      }
      try {
        connection.ws.send(payload);
        stats.framesPublished += 1;
        // 立即投递视为已排空（回执型缓冲；真实背压由断开承担）。
        connection.bufferedFrames = 0;
      } catch {
        closeSlow(connection, "send-failed");
      }
    }
  }

  /** 命令按 conversation 路由给 producer；身份由服务端会话注入，不信任 body。 */
  function routeCommand(connection, message) {
    for (const candidate of connections.values()) {
      if (candidate.role !== "producer") continue;
      if (candidate.conversationId !== connection.conversationId) continue;
      safeSend(candidate.ws, {
        kind: "command",
        connectionId: connection.connectionId,
        conversationId: connection.conversationId,
        principal: { principalId: connection.principalId },
        raw: message.command,
      });
    }
  }

  function closeSlow(connection, reason) {
    if (connection.closed) return;
    connection.closed = true;
    stats.slowConsumersDisconnected += 1;
    try {
      connection.ws.close(4429, reason);
    } catch {
      // 断开失败不影响中继状态清理。
    }
    connections.delete(connection.connectionId);
    unsubscribe(connection.connectionId);
  }

  return {
    /** 幂等开启监听。 */
    listen() {
      return new Promise((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(port, host, () => {
          const address = httpServer.address();
          resolve({ host, port: address.port, url: `ws://${host}:${address.port}` });
        });
      });
    },

    /** 签发单次 ticket（宿主侧认证后调用；本函数不做认证）。 */
    issueTicket(input) {
      const token = randomUUID().replace(/-/g, "");
      tickets.set(token, {
        role: input.role,
        conversationId: input.conversationId,
        principalId: input.principalId,
        expiresAt: clock() + RELAY_TICKET_TTL_MS,
        used: false,
      });
      return { token, expiresAt: clock() + RELAY_TICKET_TTL_MS };
    },

    /** 撤权：使 ticket 失效并立即断开该主体的现存连接。 */
    revokePrincipal(principalId) {
      for (const [token, record] of tickets) {
        if (record.principalId === principalId) tickets.delete(token);
      }
      let closedCount = 0;
      for (const connection of [...connections.values()]) {
        if (connection.principalId === principalId) {
          connection.closed = true;
          try {
            connection.ws.close(4403, "revoked");
          } catch {
            // 已断开。
          }
          connections.delete(connection.connectionId);
          unsubscribe(connection.connectionId);
          closedCount += 1;
        }
      }
      stats.revocationsApplied += closedCount;
      return closedCount;
    },

    stats: () => ({ ...stats }),
    connectionCount: () => connections.size,

    /** 关闭：释放 socket、timer、订阅，测试失败也必须 finally 调用。 */
    close() {
      return new Promise((resolve) => {
        for (const connection of connections.values()) {
          try {
            connection.ws.terminate();
          } catch {
            // 已断开。
          }
        }
        connections.clear();
        subscriptions.clear();
        tickets.clear();
        wss.close(() => {
          httpServer.close(() => resolve());
        });
      });
    },
  };
}
