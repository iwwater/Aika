import { describe, expect, it } from "vitest";
import {
  parseFeishuMessage, verifyFeishuEvent, verifyFeishuSignature, createFeishuTokenManager,
  type FeishuEventEnvelope,
} from "./feishuAdapter";

const SECRET = "feishu-encrypt-key";
const TENANT = "tenant-7365";

function makeEnvelope(overrides: Partial<FeishuEventEnvelope> = {}): FeishuEventEnvelope {
  return {
    schema: "2.0",
    header: {
      event_id: "evt-1",
      event_type: "im.message.receive_v1",
      tenant_key: TENANT,
      create_time: Math.floor(Date.now() / 1000),
    },
    event: {
      sender: { sender_id: { open_id: "ou-bound" } },
      message: {
        message_id: "om-1",
        chat_id: "oc-1",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "你好" }),
      },
    },
    ...overrides,
  };
}

function sign(payload: string, timestamp: number): string {
  // 与生产 verifyFeishuSignature 同一算法的测试桩。
  return require("node:crypto").createHash("sha256").update(`${timestamp}${payload}${SECRET}`).digest("hex");
}

describe("Feishu 适配（GW-05，fixture 轨）", () => {
  it("私聊文本 → GW-01 入站消息（复用 GW-01 契约包，GW-05-A）", () => {
    const envelope = makeEnvelope();
    const payload = JSON.stringify(envelope);
    expect(verifyFeishuSignature({ payload, signature: sign(payload, 1_700), timestamp: 1_700, encryptKey: SECRET })).toBe(true);

    const parsed = parseFeishuMessage(envelope, {
      botAccount: "feishu-bot",
      allowedTenants: [TENANT],
      boundOpenIds: ["ou-bound"],
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.message.platform).toBe("feishu");
      expect(parsed.message.isGroup).toBe(false);
      expect(parsed.message.payload).toEqual({ kind: "text", text: "你好" });
    }
  });

  it("伪造签名 / 重放 / 过期时间戳 / 未知 tenant 全部拒绝（GW-05-B）", () => {
    const envelope = makeEnvelope();
    const now = Date.now();
    const seen = new Set<string>();
    const payload = JSON.stringify(envelope);
    const good = sign(payload, Math.floor(now / 1000));

    expect(verifyFeishuEvent({
      envelope, signature: "bad", timestamp: Math.floor(now / 1000), encryptKey: SECRET,
      allowedTenants: [TENANT], seenEventIds: seen, now,
    })).toEqual({ ok: false, reason: "bad-signature" });

    // 首次合法：seen 记录 event id；同 id 再来 → 重放。
    expect(verifyFeishuEvent({
      envelope, signature: good, timestamp: Math.floor(now / 1000), encryptKey: SECRET,
      allowedTenants: [TENANT], seenEventIds: seen, now,
    })).toEqual({ ok: true });
    expect(verifyFeishuEvent({
      envelope, signature: good, timestamp: Math.floor(now / 1000), encryptKey: SECRET,
      allowedTenants: [TENANT], seenEventIds: seen, now,
    })).toEqual({ ok: false, reason: "replayed" });

    // 过期时间戳。
    const stale = makeEnvelope({ header: { ...envelope.header, create_time: Math.floor((now - 10 * 60_000) / 1000) } });
    expect(verifyFeishuEvent({
      envelope: stale, signature: sign(JSON.stringify(stale), Math.floor(now / 1000)), timestamp: Math.floor(now / 1000), encryptKey: SECRET,
      allowedTenants: [TENANT], seenEventIds: new Set(), now,
    })).toEqual({ ok: false, reason: "stale" });

    // 未知 tenant。
    const foreign = makeEnvelope({ header: { ...envelope.header, tenant_key: "tenant-other" } });
    expect(verifyFeishuEvent({
      envelope: foreign, signature: sign(JSON.stringify(foreign), Math.floor(now / 1000)), timestamp: Math.floor(now / 1000), encryptKey: SECRET,
      allowedTenants: [TENANT], seenEventIds: new Set(), now,
    })).toEqual({ ok: false, reason: "unknown-tenant" });
  });

  it("群聊/未绑定/非文本明确拒绝；token 刷新失败可见且不泄漏（GW-05-C）", async () => {
    const options = { botAccount: "feishu-bot", allowedTenants: [TENANT], boundOpenIds: ["ou-bound"] };
    expect(parseFeishuMessage(makeEnvelope({
      event: { message: { message_id: "om-g", chat_id: "oc-g", chat_type: "group", message_type: "text", content: "{\"text\":\"hi\"}" } },
    }), options)).toEqual({ ok: false, reason: "group-not-supported" });
    expect(parseFeishuMessage(makeEnvelope({
      event: { sender: { sender_id: { open_id: "ou-stranger" } }, message: { message_id: "om-u", chat_id: "oc-u", chat_type: "p2p", message_type: "text", content: "{\"text\":\"hi\"}" } },
    }), options)).toEqual({ ok: false, reason: "sender-not-bound" });
    expect(parseFeishuMessage(makeEnvelope({
      event: { sender: { sender_id: { open_id: "ou-bound" } }, message: { message_id: "om-f", chat_id: "oc-1", chat_type: "p2p", message_type: "image", content: "{}" } },
    }), options)).toEqual({ ok: false, reason: "unsupported-message-type:image" });

    // token 刷新失败可见：lastError 只带状态码，不含 secret。
    const manager = createFeishuTokenManager({
      fetchImpl: async () => ({ status: 502, body: {} }),
      appId: "cli-app",
      appSecret: "APP-SECRET-CANARY",
    });
    await expect(manager.getToken()).rejects.toThrow("token-refresh-failed:502");
    expect(manager.lastRefreshError()).toBe("token-refresh-failed:502");
    expect(manager.lastRefreshError()).not.toContain("APP-SECRET-CANARY");
  });
});
