import { describe, expect, it } from "vitest";
import {
  desktopEnvelope, legacySourceOrigin, messageDedupeKey, unverifiedTrust,
  localTrust, unknownEnvelopeForLegacy,
  type SourceEnvelope,
} from "./sourceEnvelope";

const NOW = Date.UTC(2026, 0, 10, 12, 0);

describe("桌面兼容适配（RT-01-C）", () => {
  it("桌面提交包成信封：origin/desktop、本地主体、local 信任", () => {
    const envelope = desktopEnvelope({ messageId: "m-1", receivedAt: NOW });
    expect(envelope).toEqual<SourceEnvelope>({
      version: 1,
      principalId: "local",
      accountRef: "local",
      conversationId: "local",
      origin: "desktop",
      messageId: "m-1",
      receivedAt: NOW,
      trust: { kind: "local" },
    });
  });

  it("旧 TurnSource 语义原样保留，只加映射不改名", () => {
    expect(legacySourceOrigin("text")).toBe("desktop");
    expect(legacySourceOrigin("voice")).toBe("desktop");
    // proactive 是本地编排的定时提醒，不是任何外部账户发来的。
    expect(legacySourceOrigin("proactive")).toBe("environment");
  });

  it("历史消息投影为 unknown：不伪造账户归属（RT-01-C）", () => {
    const envelope = unknownEnvelopeForLegacy(NOW);
    expect(envelope.origin).toBe("unknown");
    expect(envelope.trust).toEqual({ kind: "unverified" });
    expect(envelope.principalId).toBe("");
    expect(envelope.accountRef).toBe("");
  });
});

describe("trust 等级（RT-01）", () => {
  it("本模块只提供 local 与 unverified 两个工厂；authenticated 只能由认证端口生成", () => {
    expect(localTrust()).toEqual({ kind: "local" });
    expect(unverifiedTrust()).toEqual({ kind: "unverified" });
    // 类型层面 authenticated 携带不导出的 brand，外部构造不出这个形状：
    // 这条断言只是文档化——真正的保证在 tsc（构造 AuthenticatedTrust 缺 brand 字段即编译失败）。
  });
});

describe("消息幂等键", () => {
  it("同入口同 messageId 同键；跨入口不碰撞", () => {
    const a = desktopEnvelope({ messageId: "m-9", receivedAt: NOW });
    const b = desktopEnvelope({ messageId: "m-9", receivedAt: NOW + 1 });
    expect(messageDedupeKey(a)).toBe(messageDedupeKey(b));

    const telegram: SourceEnvelope = { ...a, origin: "telegram", accountRef: "tg:10086" };
    expect(messageDedupeKey(telegram)).not.toBe(messageDedupeKey(a));
  });
});
