import { describe, expect, it } from "vitest";
import { parsePartialReply } from "./streamingReply";

const FULL = '{"japanese_text":"おかえり。今日はどうだった？","chinese_translation":"欢迎回来。今天过得怎么样？"}';

describe("parsePartialReply", () => {
  it("完整 JSON 拿到两个字段，并标记已闭合", () => {
    expect(parsePartialReply(FULL)).toEqual({
      japaneseText: "おかえり。今日はどうだった？",
      chineseTranslation: "欢迎回来。今天过得怎么样？",
      mood: "neutral",
      japaneseComplete: true,
    });
  });

  it("正文还没写完时把已到手的部分交出去", () => {
    const partial = parsePartialReply('{"japanese_text":"おかえり。今日は');
    expect(partial.japaneseText).toBe("おかえり。今日は");
    expect(partial.japaneseComplete).toBe(false);
  });

  it("正文闭合了但翻译还没写完，翻译先不交出去", () => {
    const partial = parsePartialReply('{"japanese_text":"おかえり。","chinese_translation":"欢迎回');
    expect(partial.japaneseText).toBe("おかえり。");
    expect(partial.japaneseComplete).toBe(true);
    expect(partial.chineseTranslation).toBe("");
  });

  it("认得转义字符", () => {
    const partial = parsePartialReply('{"japanese_text":"1行目\\n2行目\\"引用\\""}');
    expect(partial.japaneseText).toBe("1行目\n2行目\"引用\"");
    expect(partial.japaneseComplete).toBe(true);
  });

  it("转义符只吐了一半时不把反斜杠当正文", () => {
    expect(parsePartialReply('{"japanese_text":"おかえり\\').japaneseText).toBe("おかえり");
    expect(parsePartialReply('{"japanese_text":"おかえり\\u30').japaneseText).toBe("おかえり");
  });

  it("代码围栏不影响解析", () => {
    expect(parsePartialReply('```json\n{"japanese_text":"おかえり。"').japaneseText).toBe("おかえり。");
  });

  it("不是 JSON 时整段当正文：有协议不支持结构化输出", () => {
    const partial = parsePartialReply("おかえり。今日はどうだった？");
    expect(partial.japaneseText).toBe("おかえり。今日はどうだった？");
    expect(partial.japaneseComplete).toBe(false);
  });

  it("空输入不炸", () => {
    expect(parsePartialReply("")).toEqual({
      japaneseText: "", chineseTranslation: "", mood: "neutral", japaneseComplete: false,
    });
    expect(parsePartialReply("{").japaneseText).toBe("");
  });

  it("逐字喂入时正文只增不减", () => {
    let previous = "";
    for (let index = 1; index <= FULL.length; index += 1) {
      const current = parsePartialReply(FULL.slice(0, index)).japaneseText;
      expect(current.startsWith(previous) || previous.startsWith(current)).toBe(true);
      if (current.length >= previous.length) previous = current;
    }
    expect(previous).toBe("おかえり。今日はどうだった？");
  });
});

describe("流式取语气", () => {
  it("mood 在第一句正文之前就能拿到——朗读参数要在开口前定下来", () => {
    const partial = parsePartialReply('{"mood":"happy","japanese_text":"おかえ');
    expect(partial.mood).toBe("happy");
    expect(partial.japaneseText).toBe("おかえ");
  });

  it("语气字符串还没闭合时不采用，否则会先 neutral 再跳到 happy", () => {
    expect(parsePartialReply('{"mood":"hap').mood).toBe("neutral");
  });

  it("纯文本回复也有语气字段，值是 neutral", () => {
    expect(parsePartialReply("おかえり").mood).toBe("neutral");
  });
});
