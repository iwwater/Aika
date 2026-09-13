import { describe, expect, it } from "vitest";
import { parseQqMessage, qqRateLimitVerdict, QQ_CAPABILITY_GAPS, QQ_SUPPORTED_SCOPES } from "./qqAdapter";

describe("QQ 适配（GW-06，fixture 轨）", () => {
  it("官方 C2C/群@ 文本 scope 精确命名并解析（GW-06-A）", () => {
    const c2c = parseQqMessage(
      { op: 0, t: "C2C_AT_MESSAGE_CREATE", d: { id: "msg-1", content: "你好", author: { user_openid: "ou-1" } } },
      { botAccount: "qq-bot", allowedScopes: QQ_SUPPORTED_SCOPES },
    );
    expect(c2c.ok).toBe(true);
    if (c2c.ok) {
      expect(c2c.message.isGroup).toBe(false);
      expect(c2c.message.payload).toEqual({ kind: "text", text: "你好" });
    }

    const group = parseQqMessage(
      { op: 0, t: "GROUP_AT_MESSAGE_CREATE", d: { id: "msg-2", content: "大家好", author: { id: "member-1" }, group_openid: "grp-1" } },
      { botAccount: "qq-bot", allowedScopes: QQ_SUPPORTED_SCOPES },
    );
    expect(group.ok).toBe(true);
    if (group.ok) expect(group.message.isGroup).toBe(true);
  });

  it("不支持能力明确拒绝：非文本/生命周期 op/未开通 scope（GW-06-A/D）", () => {
    // 未开通 C2C 的部署：scope 白名单不含 c2c-text。
    const groupOnly = parseQqMessage(
      { op: 0, t: "C2C_AT_MESSAGE_CREATE", d: { id: "m", content: "hi", author: { user_openid: "ou" } } },
      { botAccount: "qq-bot", allowedScopes: ["group@-text"] },
    );
    expect(groupOnly).toEqual({ ok: false, reason: "scope-not-supported:c2c-text" });

    // 生命周期 op（op 13 验证等）不是消息。
    expect(parseQqMessage(
      { op: 13, t: "WEBHOOK_VERIFY", d: {} },
      { botAccount: "qq-bot", allowedScopes: QQ_SUPPORTED_SCOPES },
    )).toEqual({ ok: false, reason: "unsupported-op:13" });

    // 空文本。
    expect(parseQqMessage(
      { op: 0, t: "C2C_AT_MESSAGE_CREATE", d: { id: "m2", content: "", author: { user_openid: "ou" } } },
      { botAccount: "qq-bot", allowedScopes: QQ_SUPPORTED_SCOPES },
    )).toEqual({ ok: false, reason: "empty-text" });

    // 能力差异如实列出（不伪称达到原场景）。
    expect(QQ_CAPABILITY_GAPS.length).toBeGreaterThanOrEqual(3);
  });

  it("平台限流负例：429 → retry-after 显式（GW-06-C）", () => {
    expect(qqRateLimitVerdict(429, { retry_after: 7 })).toEqual({ retryAfterMs: 7000, failed: false });
    expect(qqRateLimitVerdict(500, {}).failed).toBe(true);
  });
});
