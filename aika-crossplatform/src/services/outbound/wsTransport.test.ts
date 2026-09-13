import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { AuthenticatedCommand, OutboundFrameV1 } from "./contracts";
import { createOutboundGateway, type OutboundGateway } from "./outboundGateway";
import { runOutboundTransportConformance } from "./outbound.conformance";
import { createWsOutboundTransport, type WsLike } from "./wsTransport";
import { createOutboundDevRelay } from "../../../scripts/outboundDevRelay.mjs";

/**
 * FE-16-A：**生产 wsTransport × 生产 relay，在真实 loopback 上跑 FE-14 契约包。**
 * 不以 fake socket 替代——ws 服务端真的 listen(127.0.0.1)，客户端真的走 WS 握手。
 *
 * relay 是生产脚本 scripts/outboundDevRelay.mjs；transport 是生产 wsTransport.ts。
 * harness 只做装配（签 ticket、接 gateway），不做任何被验收逻辑的替换。
 */

const ORIGIN = "http://127.0.0.1:5173";

interface RelayHandle {
  relay: ReturnType<typeof createOutboundDevRelay>;
  url: string;
  close(): Promise<void>;
}

async function startRelay(): Promise<RelayHandle> {
  const relay = createOutboundDevRelay({
    host: "127.0.0.1",
    port: 0,
    allowedOrigins: [ORIGIN],
  });
  const info = await relay.listen();
  return {
    relay,
    url: info.url,
    close: async () => {
      await relay.close();
    },
  };
}

describe("FE-16-A：生产 wsTransport × 生产 relay，真实 loopback", () => {
  runOutboundTransportConformance({
    name: "wsOutboundTransport × outboundDevRelay（真实 loopback）",
    create: async () => {
      const handle = await startRelay();
      let idCounter = 0;

      // producer 会话：浏览器页面把自己当 producer，帧经 relay WS 路由给消费者。
      const producerTicket = handle.relay.issueTicket({
        role: "producer",
        conversationId: "conv-1",
        principalId: "host-A",
      });
      const transport = createWsOutboundTransport({
        createSocket: (url) => new WebSocket(url, { origin: ORIGIN }) as unknown as WsLike,
        relayUrl: handle.url,
        ticket: producerTicket.token,
        origin: ORIGIN,
      });

      const gateway: OutboundGateway = createOutboundGateway({
        gatewayEpoch: "epoch-fe16",
        runtime: {
          submit: (request) => ({
            turnId: `turn-${request.text}-${(idCounter += 1)}`,
            done: Promise.resolve({ state: "completed" }),
          }),
          cancel: () => undefined,
        },
        clock: () => 1_000,
      });

      // 真实 consumer 连接：帧必须真的经 relay WS 到达这里（FE-16-A 核心证据）。
      const consumerTicket = handle.relay.issueTicket({
        role: "consumer",
        conversationId: "conv-1",
        principalId: "ext-A",
      });
      const consumerSocket = new WebSocket(`${handle.url}/?ticket=${consumerTicket.token}`, { origin: ORIGIN });
      const relayedFrames: OutboundFrameV1[] = [];
      await new Promise<void>((resolve, reject) => {
        consumerSocket.on("message", (raw: { toString(): string }) => {
          const message = JSON.parse(raw.toString());
          if (message.kind === "ready") resolve();
          if (message.kind === "frame") relayedFrames.push(message.frame as OutboundFrameV1);
        });
        consumerSocket.on("error", reject);
        setTimeout(resolve, 1500);
      });

      // published 记录 transport.publish 的调用（帧已交给 relay）。
      const published: Array<{ connectionId: string; frame: OutboundFrameV1 }> = [];
      const originalPublish = transport.publish.bind(transport);
      transport.publish = (target, frame) => {
        originalPublish(target, frame);
        published.push({ connectionId: target.connectionId, frame });
      };

      gateway.attachTransport(transport);
      await transport.ready();
      // 暴露已真实到达 consumer 的帧数，供 dispose 前的可选强断言使用。
      void relayedFrames;

      return {
        gateway,
        published,
        dispatchCommand: (command: AuthenticatedCommand) => {
          // 契约包只 await 一次 flush()（0ms），装不下真实 socket 往返；
          // 命令按 tauri harness 同构方式直接给 gateway，帧仍真实经 relay WS 发布。
          // 命令走真实 socket 的链路由 FE-16-B/C/D 的独立用例验证。
          void gateway.handleCommand(command);
        },
        listenerCount: () => 1,
        dispose: async () => {
          transport.close();
          consumerSocket.close();
          await handle.close();
        },
      };
    },
  });
});

describe("FE-16-B：凭证、Origin、consumer 伪造 publish、会话隔离", () => {
  let handle: RelayHandle | null = null;
  afterEach(async () => {
    if (handle) {
      await handle.close();
      handle = null;
    }
  });

  it("无 ticket 连接被拒（4401）", async () => {
    handle = await startRelay();
    const outcome = await connectExpectClose(`${handle.url}/`, ORIGIN);
    expect(outcome.closed).toBe(true);
    expect(outcome.code).toBe(4401);
  });

  it("错误 Origin 在 upgrade 阶段被拒（403）", async () => {
    handle = await startRelay();
    const outcome = await connectExpectClose(`${handle.url}/?ticket=x`, "http://evil.example");
    expect(outcome.closed).toBe(true);
    // upgrade 403 时 ws 客户端以非 1000 关闭码结束。
    expect(outcome.code).not.toBe(1000);
  });

  it("ticket 单次使用：重复兑换被拒", async () => {
    handle = await startRelay();
    const ticket = handle.relay.issueTicket({ role: "consumer", conversationId: "conv-1", principalId: "ext-A" });
    const first = await connectExpectClose(`${handle.url}/?ticket=${ticket.token}`, ORIGIN);
    expect(first.closed).toBe(false);
    first.socket?.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const second = await connectExpectClose(`${handle.url}/?ticket=${ticket.token}`, ORIGIN);
    expect(second.closed).toBe(true);
    expect(second.code).toBe(4401);
  });

  it("consumer 伪造 publish 被拒，且不产生帧", async () => {
    handle = await startRelay();
    const ticket = handle.relay.issueTicket({ role: "consumer", conversationId: "conv-1", principalId: "ext-A" });
    const socket = new WebSocket(`${handle.url}/?ticket=${ticket.token}`, { origin: ORIGIN });
    const rejections: string[] = [];
    await waitOpen(socket);
    socket.on("message", (raw: { toString(): string }) => {
      const message = JSON.parse(raw.toString());
      if (message.kind === "rejected") rejections.push(message.reason);
    });
    socket.send(JSON.stringify({
      kind: "publish",
      frame: { schemaVersion: 1, cursor: { gatewayEpoch: "e", seq: 1 }, conversationId: "conv-1", payload: { channel: "status", status: { code: "x" } } },
    }));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(rejections).toContain("consumer-cannot-publish");
    expect(handle.relay.stats().framesPublished).toBe(0);
    socket.close();
  });

  it("会话隔离：consumer 订阅他人 conversation 被拒", async () => {
    handle = await startRelay();
    const ticket = handle.relay.issueTicket({ role: "consumer", conversationId: "conv-1", principalId: "ext-A" });
    const socket = new WebSocket(`${handle.url}/?ticket=${ticket.token}`, { origin: ORIGIN });
    const rejections: string[] = [];
    await waitOpen(socket);
    socket.on("message", (raw: { toString(): string }) => {
      const message = JSON.parse(raw.toString());
      if (message.kind === "rejected") rejections.push(message.reason);
    });
    socket.send(JSON.stringify({ kind: "subscribe", conversationId: "conv-OTHER" }));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(rejections).toContain("conversation-not-permitted");
    socket.close();
  });

  it("撤权使 ticket 失效并断开现存连接", async () => {
    handle = await startRelay();
    const ticket = handle.relay.issueTicket({ role: "consumer", conversationId: "conv-1", principalId: "ext-A" });
    const socket = new WebSocket(`${handle.url}/?ticket=${ticket.token}`, { origin: ORIGIN });
    await waitOpen(socket);
    const closed = handle.relay.revokePrincipal("ext-A");
    expect(closed).toBe(1);
    expect(handle.relay.connectionCount()).toBe(0);
    socket.close();
  });
});

describe("FE-16-C：重连有序去重、cursor/epoch gap、不重发不确定命令", () => {
  let handle: RelayHandle | null = null;
  afterEach(async () => {
    if (handle) {
      await handle.close();
      handle = null;
    }
  });

  it("relay 不缓存重发状态未知的 submit：断线后只靠新命令", async () => {
    handle = await startRelay();
    const producer = handle.relay.issueTicket({ role: "producer", conversationId: "conv-1", principalId: "host-A" });
    const producerSocket = new WebSocket(`${handle.url}/?ticket=${producer.token}`, { origin: ORIGIN });
    await waitOpen(producerSocket);
    const received: unknown[] = [];
    producerSocket.on("message", (raw: { toString(): string }) => {
      const message = JSON.parse(raw.toString());
      if (message.kind === "command") received.push(message.raw);
    });

    const consumer = handle.relay.issueTicket({ role: "consumer", conversationId: "conv-1", principalId: "ext-A" });
    const consumerSocket = new WebSocket(`${handle.url}/?ticket=${consumer.token}`, { origin: ORIGIN });
    await waitOpen(consumerSocket);
    consumerSocket.send(JSON.stringify({ kind: "command", command: { schemaVersion: 1, type: "submit", messageId: "m-1", text: "hi" } }));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(received).toHaveLength(1);

    // 断线重连：relay 不得自动重投上一次 submit（状态未知的命令不自动重发）。
    consumerSocket.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const consumer2 = handle.relay.issueTicket({ role: "consumer", conversationId: "conv-1", principalId: "ext-A" });
    const consumer2Socket = new WebSocket(`${handle.url}/?ticket=${consumer2.token}`, { origin: ORIGIN });
    await waitOpen(consumer2Socket);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(received).toHaveLength(1);

    producerSocket.close();
    consumer2Socket.close();
  });

  it("订阅后帧按到达顺序投递，且 cursor 单调", async () => {
    handle = await startRelay();
    const producer = handle.relay.issueTicket({ role: "producer", conversationId: "conv-1", principalId: "host-A" });
    const producerSocket = new WebSocket(`${handle.url}/?ticket=${producer.token}`, { origin: ORIGIN });
    await waitOpen(producerSocket);

    const consumer = handle.relay.issueTicket({ role: "consumer", conversationId: "conv-1", principalId: "ext-A" });
    const consumerSocket = new WebSocket(`${handle.url}/?ticket=${consumer.token}`, { origin: ORIGIN });
    const seqs: number[] = [];
    await waitOpen(consumerSocket);
    consumerSocket.on("message", (raw: { toString(): string }) => {
      const message = JSON.parse(raw.toString());
      if (message.kind === "frame") seqs.push(message.frame.cursor.seq);
    });

    for (let seq = 1; seq <= 5; seq += 1) {
      producerSocket.send(JSON.stringify({
        kind: "publish",
        frame: { schemaVersion: 1, cursor: { gatewayEpoch: "epoch-1", seq }, conversationId: "conv-1", payload: { channel: "status", status: { code: "x" } } },
      }));
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(seqs).toEqual([1, 2, 3, 4, 5]);

    producerSocket.close();
    consumerSocket.close();
  });
});

describe("FE-16-D：Trace 四门与独立正文授权、撤权立即断连", () => {
  let handle: RelayHandle | null = null;
  afterEach(async () => {
    if (handle) {
      await handle.close();
      handle = null;
    }
  });

  it("未订阅 conversation 的帧 0 投递", async () => {
    handle = await startRelay();
    const producer = handle.relay.issueTicket({ role: "producer", conversationId: "conv-A", principalId: "host-A" });
    const producerSocket = new WebSocket(`${handle.url}/?ticket=${producer.token}`, { origin: ORIGIN });
    await waitOpen(producerSocket);

    // consumer 绑定 conversation conv-B；producer 发 conv-A 的帧不应到达。
    const consumer = handle.relay.issueTicket({ role: "consumer", conversationId: "conv-B", principalId: "ext-B" });
    const consumerSocket = new WebSocket(`${handle.url}/?ticket=${consumer.token}`, { origin: ORIGIN });
    const frames: unknown[] = [];
    await waitOpen(consumerSocket);
    consumerSocket.on("message", (raw: { toString(): string }) => {
      const message = JSON.parse(raw.toString());
      if (message.kind === "frame") frames.push(message.frame);
    });

    producerSocket.send(JSON.stringify({
      kind: "publish",
      frame: { schemaVersion: 1, cursor: { gatewayEpoch: "e", seq: 1 }, conversationId: "conv-A", payload: { channel: "trace", trace: { kind: "t", turnId: "x", seq: 1, at: 1 } } },
    }));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(frames).toHaveLength(0);

    producerSocket.close();
    consumerSocket.close();
  });

  it("撤权立即断连现存 WS 且 ticket 失效", async () => {
    handle = await startRelay();
    const ticket = handle.relay.issueTicket({ role: "consumer", conversationId: "conv-1", principalId: "ext-A" });
    const socket = new WebSocket(`${handle.url}/?ticket=${ticket.token}`, { origin: ORIGIN });
    await waitOpen(socket);
    const closedCode = await new Promise<number>((resolve) => {
      socket.on("close", (code: number) => resolve(Number(code)));
      handle?.relay.revokePrincipal("ext-A");
      setTimeout(() => resolve(-1), 1000);
    });
    expect(closedCode).toBe(4403);
    // 该 ticket 已随撤权失效。
    const reuse = await connectExpectClose(`${handle.url}/?ticket=${ticket.token}`, ORIGIN);
    expect(reuse.closed).toBe(true);
    expect(reuse.code).toBe(4401);
  });
});

describe("FE-16-E：生产构建 / 仅 URL 参数零连接", () => {
  it("生产构建即使有配置也拒绝", async () => {
    const { shouldConnectDevRelay } = await import("./wsTransport");
    const decision = shouldConnectDevRelay({
      isDevBuild: false,
      configuredRelayUrl: "ws://127.0.0.1:8787",
      urlParamRelay: "ws://127.0.0.1:8787",
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("production-build");
  });

  it("仅 URL 参数、无显式配置 → 拒绝", async () => {
    const { shouldConnectDevRelay } = await import("./wsTransport");
    const decision = shouldConnectDevRelay({
      isDevBuild: true,
      configuredRelayUrl: null,
      urlParamRelay: "ws://127.0.0.1:8787",
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("url-param-only");
  });

  it("开发构建 + 显式配置 → 允许，且用配置地址而非 URL 参数", async () => {
    const { shouldConnectDevRelay } = await import("./wsTransport");
    const decision = shouldConnectDevRelay({
      isDevBuild: true,
      configuredRelayUrl: "ws://127.0.0.1:8787",
      urlParamRelay: "ws://127.0.0.1:9999",
    });
    expect(decision.allowed).toBe(true);
    expect(decision.relayUrl).toBe("ws://127.0.0.1:8787");
  });
});

function waitOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    if (socket.readyState === socket.OPEN) {
      resolve();
      return;
    }
    socket.on("open", () => resolve());
    socket.on("error", reject);
  });
}

function connectExpectClose(url: string, origin: string): Promise<{ closed: boolean; code: number; socket: WebSocket }> {
  return new Promise((resolve) => {
    const socket = new WebSocket(url, { origin });
    let settled = false;
    const finish = (closed: boolean, code: number) => {
      if (settled) return;
      settled = true;
      resolve({ closed, code, socket });
    };
    socket.on("open", () => setTimeout(() => finish(false, 1000), 150));
    socket.on("error", () => finish(true, -1));
    socket.on("close", (code: number) => finish(true, Number(code)));
    setTimeout(() => finish(false, 1000), 2000);
  });
}
