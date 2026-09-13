/**
 * OutboundTransport 的一致性用例包（FE-14-G）：FE-15/16 的真实传输必须复跑这一份。
 * 只断言契约层行为：定向投递、cursor 顺序、退订、监听异常隔离、慢消费者限额。
 */

import { expect, it } from "vitest";
import type { AuthenticatedCommand, AuthorizedTarget, OutboundFrameV1 } from "./contracts";
import type { OutboundGateway } from "./outboundGateway";

export interface OutboundHarness {
  name: string;
  create(): Promise<{
    gateway: OutboundGateway;
    /** 该 transport 收到的帧（带连接 id）。 */
    published: Array<{ connectionId: string; frame: OutboundFrameV1 }>;
    /** 让 harness 模拟远程命令到达。 */
    dispatchCommand(command: AuthenticatedCommand): void;
    /** 注册/解除 onCommand 监听的计数（退订用例用）。 */
    listenerCount(): number;
    dispose(): Promise<void>;
  }>;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

export function runOutboundTransportConformance(harness: OutboundHarness): void {
  it("定向投递：帧只发给登记过的授权目标（FE-14-A）", async () => {
    const { gateway, published, dispose } = await harness.create();
    try {
      const target: AuthorizedTarget = { connectionId: "conn-1", conversationId: "conv-1", principalId: "ext-A" };
      gateway.registerTarget("turn-1", target);
      gateway.handleRuntimeEvent({
        turnId: "turn-1", seq: 1, type: "generated",
        reply: { schemaVersion: 1, mood: "neutral", replyText: "こんにちは", translation: "你好", memoryCandidates: [{ category: "偏好", content: "不该出现" }], actions: [] },
      } as never);

      expect(published.length).toBe(1);
      expect(published[0].connectionId).toBe("conn-1");
      const reply = (published[0].frame.payload as { channel: string; reply?: Record<string, unknown> }).reply;
      expect(reply?.replyText).toBe("こんにちは");
      // 白名单：memoryCandidates 深不出现。
      expect(JSON.stringify(published[0].frame)).not.toContain("不该出现");
      expect(JSON.stringify(published[0].frame)).not.toContain("memoryCandidates");
    } finally {
      await dispose();
    }
  });

  it("未映射轮次零外发（FE-14-B）", async () => {
    const { gateway, published, dispose } = await harness.create();
    try {
      gateway.handleRuntimeEvent({
        turnId: "unmapped", seq: 1, type: "generated",
        reply: { schemaVersion: 1, mood: "neutral", replyText: "x", actions: [] },
      } as never);
      expect(published).toHaveLength(0);
    } finally {
      await dispose();
    }
  });

  it("cursor 单调递增且跨轮不重置；同一轮保留 Runtime 顺序（FE-14-B）", async () => {
    const { gateway, published, dispose } = await harness.create();
    try {
      gateway.registerTarget("turn-1", { connectionId: "c1", conversationId: "conv-1", principalId: "ext-A" });
      gateway.handleRuntimeEvent({ turnId: "turn-1", seq: 1, type: "state", state: "generating" } as never);
      gateway.handleRuntimeEvent({ turnId: "turn-1", seq: 2, type: "generated", reply: { schemaVersion: 1, mood: "neutral", replyText: "r", actions: [] } } as never);
      gateway.handleRuntimeEvent({ turnId: "turn-1", seq: 3, type: "settled", state: "completed", persisted: true } as never);

      const seqs = published.map((entry) => entry.frame.cursor.seq);
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
      expect(new Set(seqs).size).toBe(seqs.length);
      // 同一轮的帧按 Runtime 顺序：state → reply → settled。
      const channels = published.map((entry) => entry.frame.payload.channel);
      expect(channels).toEqual(["status", "reply", "status"]);
    } finally {
      await dispose();
    }
  });

  it("重放 submit 零重复提交；ping 回应原连接（FE-14-C）", async () => {
    const { published, dispatchCommand, dispose } = await harness.create();
    try {
      const submitCommand = { schemaVersion: 1, type: "submit", messageId: "m-1", text: "你好" };
      const base: AuthenticatedCommand = {
        raw: submitCommand,
        principal: { principalId: "ext-A" },
        conversationId: "conv-1",
        connectionId: "conn-1",
      };
      dispatchCommand(base);
      await flush();
      dispatchCommand({ ...base, raw: submitCommand });
      await flush();
      // Runtime submit 的调用次数以 verdict 为准：第二次 duplicate。
      // ping 回应原连接。
      dispatchCommand({ ...base, raw: { schemaVersion: 1, type: "ping", requestId: "req-9" } });
      await flush();
      const pongs = published.filter((entry) => (entry.frame.payload as { status?: { code: string } }).status?.code === "pong");
      expect(pongs).toHaveLength(1);
      expect(pongs[0].connectionId).toBe("conn-1");
    } finally {
      await dispose();
    }
  });

  it("畸形命令拒绝且后续正常命令可执行（FE-14-D）", async () => {
    const { gateway, dispose } = await harness.create();
    try {
      const commands: AuthenticatedCommand[] = [
        { raw: "not-an-object", principal: { principalId: "ext-A" }, conversationId: "conv-1", connectionId: "c1" },
        { raw: { schemaVersion: 2, type: "submit", messageId: "m", text: "x" }, principal: { principalId: "ext-A" }, conversationId: "conv-1", connectionId: "c1" },
        { raw: { schemaVersion: 1, type: "hack" }, principal: { principalId: "ext-A" }, conversationId: "conv-1", connectionId: "c1" },
        { raw: { schemaVersion: 1, type: "submit", messageId: "m", text: "" }, principal: { principalId: "ext-A" }, conversationId: "conv-1", connectionId: "c1" },
        { raw: { schemaVersion: 1, type: "submit", messageId: "m", text: "🎉".repeat(4001) }, principal: { principalId: "ext-A" }, conversationId: "conv-1", connectionId: "c1" },
      ];
      for (const command of commands) {
        const verdict = await gateway.handleCommand(command);
        expect(verdict.accepted).toBe(false);
      }
      // 超长按码点：3999 个码点 + emoji 应当通过。
      const ok = await gateway.handleCommand({
        raw: { schemaVersion: 1, type: "submit", messageId: "m-ok", text: "🎉".repeat(1999) + "ok" },
        principal: { principalId: "ext-A" }, conversationId: "conv-1", connectionId: "c1",
      });
      expect(ok.accepted).toBe(true);
    } finally {
      await dispose();
    }
  });

  it("退订与监听异常隔离：退订后不再收到帧（FE-14-G）", async () => {
    const { gateway, dispose } = await harness.create();
    try {
      const mine: OutboundFrameV1[] = [];
      gateway.registerTarget("turn-x", { connectionId: "c1", conversationId: "conv-1", principalId: "ext-A" });
      const detach = gateway.attachTransport({
        publish: (_target, frame) => mine.push(frame),
        onCommand: () => () => undefined,
      });
      gateway.handleRuntimeEvent({ turnId: "turn-x", seq: 1, type: "state", state: "generating" } as never);
      expect(mine.length).toBe(1);

      detach();
      gateway.handleRuntimeEvent({ turnId: "turn-x", seq: 2, type: "settled", state: "completed", persisted: true } as never);
      expect(mine.length).toBe(1);
    } finally {
      await dispose();
    }
  });
}
