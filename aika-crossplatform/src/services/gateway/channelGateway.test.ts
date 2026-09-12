import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { GatewayInboundMessageV1, OutboundMessageV1 } from "../../domain/gateway";
import type { AikaStorage } from "../storage/contracts";
import { createChannelGateway, type GatewayRuntimePort, type GatewayTransport } from "./channelGateway";

const BASE = Date.UTC(2026, 0, 10, 12, 0);
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function message(overrides: Partial<GatewayInboundMessageV1> = {}): GatewayInboundMessageV1 {
  return {
    schemaVersion: 1,
    messageId: "pm-1",
    platform: "telegram",
    botAccount: "aika_bot",
    tenant: "-10086",
    sender: "10086",
    chatId: "10086",
    isGroup: false,
    receivedAt: BASE,
    payload: { kind: "text", text: "你好" },
    ...overrides,
  };
}

interface Fixture {
  gateway: ReturnType<typeof createChannelGateway>;
  settings: Map<string, string>;
  submitCalls: { conversationId: string; principalId: string; text: string }[];
  deliveries: { chatId: string; text: string; outboundId: string }[];
  /** 控制下一次 transport.send 的返回。 */
  nextDelivery: { outcome: "sent" | "failed" | "unknown"; retryAfterMs?: number }[];
  advance(ms: number): void;
  releaseSubmit(): void;
}

function buildGateway(): Fixture {
  const settings = new Map<string, string>();
  let now = BASE;
  const storage = {
    async getSetting(key: string) { return settings.get(key) ?? null; },
    async setSetting(key: string, value: string) { settings.set(key, value); },
  } as unknown as AikaStorage;

  const submitCalls: { conversationId: string; principalId: string; text: string }[] = [];
  let gate: (() => void) | null = null;
  const runtime: GatewayRuntimePort = {
    submit: async (input) => {
      submitCalls.push({ conversationId: input.conversationId, principalId: input.principalId, text: input.text });
      await new Promise<void>((resolve) => {
        gate = resolve;
      });
      return { state: "completed", replyText: `回信：${input.text}` };
    },
  };

  const deliveries: { chatId: string; text: string; outboundId: string }[] = [];
  const nextDelivery: { outcome: "sent" | "failed" | "unknown"; retryAfterMs?: number }[] = [];
  const transport: GatewayTransport = {
    supportsIdempotentDelivery: false,
    send: async (outbound) => {
      const plan = nextDelivery.shift() ?? { outcome: "sent" as const };
      deliveries.push({ chatId: outbound.destination.chatId, text: outbound.text, outboundId: outbound.outboundId });
      return plan;
    },
  };

  let idCounter = 0;
  const gateway = createChannelGateway({
    loadStorage: async () => storage,
    runtime,
    transport,
    bindings: { principalFor: async () => "ext-A" },
    clock: () => now,
    idFactory: () => `id-${(idCounter += 1)}`,
  });

  return {
    gateway,
    settings,
    submitCalls,
    deliveries,
    nextDelivery,
    advance: (ms: number) => { now += ms; },
    // 每次 submit 都挂起新的 gate；release 一次放行一轮。
    releaseSubmit: () => {
      const current = gate;
      gate = null;
      current?.();
    },
  };
}

describe("Channel Gateway（GW-01）", () => {
  it("重复入站只触发一次 Runtime；重启恢复不重跑已提交的副作用（GW-01-A）", async () => {
    const fixture = buildGateway();
    const first = await fixture.gateway.ingest(message());
    const second = await fixture.gateway.ingest(message({ receivedAt: BASE + 1 }));
    expect(first.verdict).toBe("accepted");
    expect(second).toMatchObject({ verdict: "duplicate" });

    await flush();
    fixture.releaseSubmit();
    await flush();

    // 模拟崩溃恢复：新实例同库，该消息已是 completed——再 ingest 仍是 duplicate。
    const reborn = buildGateway();
    for (const [key, value] of fixture.settings) reborn.settings.set(key, value);
    const verdict = await reborn.gateway.ingest(message());
    expect(verdict.verdict).toBe("duplicate");
  });

  it("提交后崩溃：恢复标 unknown，不自动再次调用 Runtime（GW-01-A）", async () => {
    const fixture = buildGateway();
    await fixture.gateway.ingest(message());
    await flush(); // 已提交 Runtime（running），但没放行结算。

    // 崩溃重启：同库新实例。Runtime 换成「被调用就爆炸」的哨兵。
    const settings = fixture.settings;
    const storage = {
      async getSetting(key: string) { return settings.get(key) ?? null; },
      async setSetting(key: string, value: string) { settings.set(key, value); },
    } as unknown as AikaStorage;
    const reborn = createChannelGateway({
      loadStorage: async () => storage,
      runtime: { submit: async () => { throw new Error("must not be called"); } },
      transport: { supportsIdempotentDelivery: false, send: async () => ({ outcome: "sent" }) },
      bindings: { principalFor: async () => "ext-A" },
    });
    const recovered = await reborn.recover();
    expect(recovered.inboxUnknown).toBe(1);

    const inbox = await reborn.inbox();
    expect(inbox.find((record) => record.message.messageId === "pm-1")?.state).toBe("unknown");
  });

  it("附件校验：超限与未知类型拒绝；voice 可受理；image 只作附件不做理解（GW-01-B）", async () => {
    const fixture = buildGateway();
    const oversized = await fixture.gateway.ingest(message({
      messageId: "pm-big",
      payload: { kind: "voice", attachment: { attachmentId: "a1", mediaType: "audio/ogg", sizeBytes: 21 * 1024 * 1024 } },
    }));
    expect(oversized).toMatchObject({ verdict: "rejected" });

    const unknownType = await fixture.gateway.ingest(message({
      messageId: "pm-type",
      payload: { kind: "file", attachment: { attachmentId: "a2", mediaType: "application/x-msdownload", sizeBytes: 10 } },
    }));
    expect(unknownType).toMatchObject({ verdict: "rejected" });

    const voice = await fixture.gateway.ingest(message({
      messageId: "pm-voice",
      payload: { kind: "voice", attachment: { attachmentId: "a3", mediaType: "audio/ogg", sizeBytes: 1200 } },
    }));
    expect(voice.verdict).toBe("accepted");
    await flush();
    fixture.releaseSubmit();
    await flush();
    // 第一版不做转写理解：文本替换为附件表示。
    expect(fixture.submitCalls[fixture.submitCalls.length - 1]?.text).toContain("第一版不做理解");
  });

  it("未绑定发件人的消息不入个人上下文：提交被拒且 conversation 以 gw 为界（GW-01-B）", async () => {
    const settings = new Map<string, string>();
    const storage = {
      async getSetting(key: string) { return settings.get(key) ?? null; },
      async setSetting(key: string, value: string) { settings.set(key, value); },
    } as unknown as AikaStorage;
    const submitCalls: string[] = [];
    const gateway = createChannelGateway({
      loadStorage: async () => storage,
      runtime: { submit: async (input) => { submitCalls.push(input.conversationId); return { state: "completed" }; } },
      transport: { supportsIdempotentDelivery: false, send: async () => ({ outcome: "sent" }) },
      // 绑定服务查不到该发件人。
      bindings: { principalFor: async () => null },
    });

    const verdict = await gateway.ingest(message({ isGroup: true, chatId: "group-1" }));
    expect(verdict.verdict).toBe("accepted");
    await flush();
    expect(submitCalls).toEqual([]);

    const inbox = await gateway.inbox();
    expect(inbox.find((record) => record.message.messageId === "pm-1")?.note).toBe("sender-not-bound");
  });

  it("同会话有序：两条消息按到达顺序提交；回信按原目的地投递（GW-01-C）", async () => {
    const fixture = buildGateway();
    await fixture.gateway.ingest(message({ messageId: "pm-1", payload: { kind: "text", text: "第一句" } }));
    await fixture.gateway.ingest(message({ messageId: "pm-2", receivedAt: BASE + 1, payload: { kind: "text", text: "第二句" } }));
    await flush();

    fixture.releaseSubmit();
    await flush();
    fixture.releaseSubmit();
    await flush();

    expect(fixture.submitCalls.map((call) => call.text).slice(-2)).toEqual(["第一句", "第二句"]);

    // 回信目的地绑定原请求（原会话原聊天，LLM 改不了收件人）。
    const outbox: readonly OutboundMessageV1[] = await fixture.gateway.outbox();
    expect(outbox.map((item) => item.text)).toEqual(["回信：第一句", "回信：第二句"]);
    expect(outbox.every((item) => item.destination.chatId === "10086")).toBe(true);
    expect(outbox.every((item) => item.inReplyToKey?.includes("pm-") ?? false)).toBe(true);
  });

  it("重试耗尽有失败记录；unknown 不盲目重试（GW-01-C）", async () => {
    const fixture = buildGateway();
    const reply = await fixture.gateway.enqueueReply({
      destination: { platform: "telegram", botAccount: "aika_bot", tenant: "-10086", chatId: "10086" },
      text: "未送达的消息",
    });
    expect(reply.ok).toBe(true);
    fixture.nextDelivery.push(
      { outcome: "failed" },
      { outcome: "failed" },
      { outcome: "failed" },
    );

    await fixture.gateway.flushOutbox();
    fixture.advance(6_000);
    await fixture.gateway.flushOutbox();
    fixture.advance(6_000);
    const summary = await fixture.gateway.flushOutbox();

    expect(summary.failed).toBe(1);
    const outbox: readonly OutboundMessageV1[] = await fixture.gateway.outbox();
    const record = outbox.find((item) => item.text === "未送达的消息");
    expect(record?.state).toBe("failed");
    // lastError 是最后一次传输错误；attempts=3 已表达重试耗尽。
    expect(record?.lastError).toBe("delivery-failed");
    expect(record?.attempts).toBe(3);
  });

  it("发送不确认：不支持幂等键的平台标 unknown 终态，不重试（GW-01-D）", async () => {
    const fixture = buildGateway();
    await fixture.gateway.enqueueReply({
      destination: { platform: "telegram", botAccount: "aika_bot", tenant: "-10086", chatId: "10086" },
      text: "不知道送没送到",
    });
    fixture.nextDelivery.push({ outcome: "unknown" });

    const summary = await fixture.gateway.flushOutbox();
    expect(summary.unknown).toBe(1);
    const outbox: readonly OutboundMessageV1[] = await fixture.gateway.outbox();
    expect(outbox[0].state).toBe("unknown");
    expect(outbox[0].attempts).toBe(1);
  });

  it("适配器不能调用 LLM/Memory：gateway 生产源码不 import 编排与个人数据实现（GW-01-D）", () => {
    const source = readFileSync(join(__dirname, "channelGateway.ts"), "utf8");
    expect(source).not.toMatch(/from\s+["'][^"']*providerClient/);
    expect(source).not.toMatch(/from\s+["'][^"']*memoryRepository/);
    expect(source).not.toMatch(/from\s+["'][^"']*companionRuntime/);
    expect(source).not.toMatch(/from\s+["'][^"']*knowledgeIndex/);
  });
});
