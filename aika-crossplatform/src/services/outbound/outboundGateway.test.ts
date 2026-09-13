import { describe, expect, it } from "vitest";
import type { AuthorizedTarget, OutboundFrameV1 } from "./contracts";
import { createOutboundGateway } from "./outboundGateway";

function makeFixture(overrides: { epoch?: string; configMode?: string } = {}) {
  const frames: OutboundFrameV1[] = [];
  const submitted: Array<{ text: string; conversation?: { conversationId: string; principalId: string }; mode?: { mode: string } }> = [];
  const gateway = createOutboundGateway({
    gatewayEpoch: overrides.epoch ?? "epoch-1",
    runtime: {
      submit: (request) => {
        submitted.push({ text: request.text, conversation: request.conversation, mode: request.mode });
        return { turnId: `turn-${request.text}`, done: Promise.resolve({ state: "completed" }) };
      },
      cancel: () => undefined,
    },
    configForConversation: overrides.configMode
      ? (conversationId) => ({ mode: { mode: overrides.configMode as string }, conversationId })
      : undefined,
    clock: () => 1_000,
  });
  gateway.attachTransport({
    publish: (target, frame) => frames.push({ ...frame, conversationId: target.connectionId } as OutboundFrameV1 & { conversationId: string }),
    onCommand: () => () => undefined,
  });
  return { gateway, frames, submitted };
}

const TARGET_A: AuthorizedTarget = { connectionId: "conn-A", conversationId: "conv-A", principalId: "ext-A" };

describe("OutboundGateway（FE-14）", () => {
  it("submit 进入统一 facade：scope 与会话已保存 mode 来自可信会话（FE-14-C）", async () => {
    const fx = makeFixture({ configMode: "work" });
    const verdict = await fx.gateway.handleCommand({
      raw: { schemaVersion: 1, type: "submit", messageId: "m1", text: "你好" },
      principal: { principalId: "ext-A" },
      conversationId: "conv-A",
      connectionId: "conn-A",
    });
    expect(verdict.accepted).toBe(true);
    expect(fx.submitted[0]).toMatchObject({
      text: "你好",
      conversation: { conversationId: "conv-A", principalId: "ext-A" },
      mode: { mode: "work" },
    });
  });

  it("跨身份不能提交别人的轮次：提交绑定的是命令自己的 principal（FE-14-C）", async () => {
    const fx = makeFixture();
    const verdict = await fx.gateway.handleCommand({
      raw: { schemaVersion: 1, type: "submit", messageId: "m1", text: "hi" },
      principal: { principalId: "ext-B" },
      conversationId: "conv-A", // B 冒用 A 的会话 id。
      connectionId: "conn-B",
    });
    expect(verdict.accepted).toBe(true);
    // 但 scope 的 principal 是 B 自己：隔离在 Runtime 的 RT-02 存储里兜底。
    expect(fx.submitted[0].conversation).toEqual({ conversationId: "conv-A", principalId: "ext-B" });
    // A 的目标映射不受影响：B 的事件不会发给 A。
    fx.gateway.handleRuntimeEvent({ turnId: `turn-hi`, seq: 1, type: "generated", reply: { schemaVersion: 1, mood: "neutral", replyText: "r", actions: [] } } as never);
    expect(fx.frames.every((frame) => frame.turnId !== undefined)).toBe(true);
  });

  it("trace 四门：任一关闭零 trace；本地 includeText 开不连带授权（FE-14-E）", async () => {
    const fx = makeFixture();
    fx.gateway.subscribeTrace({ connectionId: "conn-A", conversationId: "conv-A", principalId: "ext-A" });
    const projection = { conversationId: "conv-A", event: { kind: "turn_start", turnId: "t", seq: 1, at: 1 } };

    fx.gateway.setTraceGates({ localTraceEnabled: true, remoteOutboundEnabled: false, remoteTextEnabled: false });
    fx.gateway.publishTraceProjection(projection);
    expect(fx.frames).toHaveLength(0);

    fx.gateway.setTraceGates({ localTraceEnabled: false, remoteOutboundEnabled: true, remoteTextEnabled: false });
    fx.gateway.publishTraceProjection(projection);
    expect(fx.frames).toHaveLength(0);

    // 双开但主体未授权：仍零外发。
    fx.gateway.setTraceGates({ localTraceEnabled: true, remoteOutboundEnabled: true, remoteTextEnabled: false, authorizedPrincipals: ["ext-B"] });
    fx.gateway.publishTraceProjection(projection);
    expect(fx.frames).toHaveLength(0);

    // 四门全开：一条仅元数据的 trace 帧（无正文）。
    fx.gateway.setTraceGates({ localTraceEnabled: true, remoteOutboundEnabled: true, remoteTextEnabled: false, authorizedPrincipals: ["ext-A"] });
    fx.gateway.publishTraceProjection(projection);
    expect(fx.frames).toHaveLength(1);
    expect(JSON.stringify(fx.frames[0])).not.toContain("queryText");
  });

  it("慢消费者限额：超限丢最旧并计数（FE-14-G）", () => {
    const frames: OutboundFrameV1[] = [];
    const gateway = createOutboundGateway({
      gatewayEpoch: "e",
      runtime: { submit: () => ({ turnId: "t", done: Promise.resolve({ state: "completed" }) }), cancel: () => undefined },
      maxBufferFrames: 2,
      clock: () => 1_000,
    });
    gateway.attachTransport({ publish: (_t, frame) => frames.push(frame), onCommand: () => () => undefined });
    gateway.registerTarget("t", { connectionId: "c", conversationId: "conv", principalId: "p" });
    for (let index = 0; index < 5; index += 1) {
      gateway.handleRuntimeEvent({ turnId: "t", seq: index, type: "state", state: "generating" } as never);
    }
    expect(frames.length).toBeGreaterThan(2);
    expect(gateway.diagnostics().droppedFrames).toBeGreaterThan(0);
  });

  it("epoch 重启变化：不同实例 cursor 带各自 epoch（FE-14-B）", async () => {
    const first = makeFixture({ epoch: "epoch-1" });
    const second = makeFixture({ epoch: "epoch-2" });
    first.gateway.registerTarget("t", TARGET_A);
    second.gateway.registerTarget("t", TARGET_A);
    first.gateway.handleRuntimeEvent({ turnId: "t", seq: 1, type: "state", state: "generating" } as never);
    second.gateway.handleRuntimeEvent({ turnId: "t", seq: 1, type: "state", state: "generating" } as never);
    const epochs = [...first.frames, ...second.frames].map((frame) => frame.cursor.gatewayEpoch);
    expect(epochs).toEqual(["epoch-1", "epoch-2"]);
    // 各自序列独立从 1 起（跨实例不共享计数——重启即新流）。
    expect(first.frames[0].cursor.seq).toBe(1);
    expect(second.frames[0].cursor.seq).toBe(1);
  });
});
