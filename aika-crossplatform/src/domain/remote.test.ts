import { describe, expect, it } from "vitest";
import type { ChatMessage } from "./conversation";
import { createRemoteToken, normalizePort, parseSendText, toRemoteMessages } from "./remote";

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "1", role: "assistant", content: "おかえり", japaneseText: "おかえり",
    chineseTranslation: "你回来了", createdAt: 0, time: "21:30", ...overrides,
  };
}

describe("toRemoteMessages", () => {
  it("只给手机它显示得了的字段", () => {
    expect(toRemoteMessages([message()])).toEqual([
      { role: "assistant", text: "おかえり", translation: "你回来了", time: "21:30" },
    ]);
  });

  it("还没答完的那一条不发过去", () => {
    // 手机没有流式通道，与其显示半句话，不如等这一轮完整了再出现
    expect(toRemoteMessages([message({ pending: true, content: "おか" })])).toEqual([]);
  });

  it("失败的那一条照发，并标出来", () => {
    // 失败的那条没有 japaneseText，正文就在 content 里
    const [remote] = toRemoteMessages([
      message({ error: true, japaneseText: undefined, chineseTranslation: undefined, content: "这次没有发出去：401" }),
    ]);
    expect(remote.error).toBe(true);
    expect(remote.text).toContain("401");
  });

  it("没有翻译时不带这个字段", () => {
    const [remote] = toRemoteMessages([message({ chineseTranslation: "" })]);
    expect(remote.translation).toBeUndefined();
  });
});

describe("parseSendText", () => {
  it("取出手机发来的那句话", () => {
    expect(parseSendText('{"text":"  今天有点累  "}')).toBe("今天有点累");
  });

  it("空的、坏的、字段不对的都返回空串，由调用方回明确的错误", () => {
    expect(parseSendText('{"text":"   "}')).toBe("");
    expect(parseSendText("不是 JSON")).toBe("");
    expect(parseSendText('{"message":"喂"}')).toBe("");
  });
});

describe("normalizePort", () => {
  it("低位端口不收：Windows 上要管理员权限", () => {
    expect(normalizePort(80)).toBeNull();
    expect(normalizePort(1023)).toBeNull();
  });

  it("非整数和越界都不收", () => {
    expect(normalizePort("8765.5")).toBeNull();
    expect(normalizePort(70000)).toBeNull();
    expect(normalizePort("")).toBeNull();
  });

  it("合法端口原样返回，字符串也认", () => {
    expect(normalizePort(8765)).toBe(8765);
    expect(normalizePort("9000")).toBe(9000);
  });
});

describe("createRemoteToken", () => {
  it("32 位十六进制，每次都不一样", () => {
    const token = createRemoteToken();
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(token).not.toBe(createRemoteToken());
  });
});
