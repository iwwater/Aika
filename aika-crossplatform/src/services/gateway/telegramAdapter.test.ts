import { describe, expect, it } from "vitest";
import {
  parseTelegramUpdate, redactTelegramUrl, sendMessageUrl, splitTelegramText,
} from "./telegramAdapter";

const BOT_TOKEN = "123456:SECRET-TOKEN";

describe("Telegram 适配（GW-02，fixture 轨）", () => {
  it("官方 update 结构 → 入站消息；私聊/群聊区分正确（GW-02-A）", () => {
    const update = {
      update_id: 1001,
      message: {
        message_id: 42,
        from: { id: 10086, is_bot: false },
        chat: { id: 10086, type: "private" },
        date: 1768046400,
        text: "こんにちは",
      },
    };
    const parsed = parseTelegramUpdate(update, { botAccount: "aika_bot" });
    expect(parsed).toMatchObject({
      schemaVersion: 1,
      messageId: "42",
      platform: "telegram",
      tenant: "10086",
      sender: "10086",
      chatId: "10086",
      isGroup: false,
      payload: { kind: "text", text: "こんにちは" },
    });

    const group = parseTelegramUpdate({
      update_id: 1002,
      message: { message_id: 43, chat: { id: -100200, type: "supergroup" }, from: { id: 10086 }, text: "大家好" },
    }, { botAccount: "aika_bot" });
    expect(group?.isGroup).toBe(true);
  });

  it("重复 update / 无 message 的 update 返回 null，由 offset 机制消化", () => {
    expect(parseTelegramUpdate({ update_id: 1003 }, { botAccount: "aika_bot" })).toBeNull();
    expect(parseTelegramUpdate(null, { botAccount: "aika_bot" })).toBeNull();
  });

  it("长文本 Unicode 安全切分：emoji 代理对不被劈开，切片 id 稳定（GW-02-A）", () => {
    const text = "🎉".repeat(3000) + "结尾".repeat(1100);
    const slices = splitTelegramText(text, 4096, "pm-9");
    expect(slices).toHaveLength(2);
    // 码点切分：两段拼回原文无损。
    expect(slices.map((s) => s.text).join("")).toBe(text);
    expect(slices[0].sliceId).toBe("pm-9#0");
    expect(slices[1].sliceId).toBe("pm-9#1");
    // 第一段结尾不可能是半个代理对（high surrogate）。
    const last = slices[0].text.codePointAt(slices[0].text.length - 1) ?? 0;
    expect(last >= 0x10000 || !(last >= 0xd800 && last <= 0xdbff)).toBe(true);
  });

  it("token 不入日志：脱敏函数与 URL 构造（GW-02-C）", () => {
    const url = sendMessageUrl(BOT_TOKEN);
    expect(url).toContain(BOT_TOKEN);
    expect(redactTelegramUrl(url)).toBe("https://api.telegram.org/bot<token>/sendMessage");
    expect(redactTelegramUrl(url)).not.toContain(BOT_TOKEN);
  });
});
