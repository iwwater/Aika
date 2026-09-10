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

  it("旧字段可能被后到的 canonical 覆盖时先缓冲，避免正文回退", () => {
    const partial = parsePartialReply('{"japanese_text":"おかえり。今日は');
    expect(partial.japaneseText).toBe("");
    expect(partial.japaneseComplete).toBe(false);
  });

  it("正文闭合了但翻译还没写完，翻译先不交出去", () => {
    const partial = parsePartialReply('{"japanese_text":"おかえり。","chinese_translation":"欢迎回');
    expect(partial.japaneseText).toBe("");
    expect(partial.japaneseComplete).toBe(false);
    expect(partial.chineseTranslation).toBe("");
  });

  it("认得转义字符", () => {
    const partial = parsePartialReply('{"japanese_text":"1行目\\n2行目\\"引用\\""}');
    expect(partial.japaneseText).toBe("1行目\n2行目\"引用\"");
    expect(partial.japaneseComplete).toBe(true);
  });

  it("转义符只吐了一半时不把反斜杠当正文", () => {
    expect(parsePartialReply('{"japanese_text":"おかえり\\').japaneseText).toBe("");
    expect(parsePartialReply('{"japanese_text":"おかえり\\u30').japaneseText).toBe("");
  });

  it("代码围栏不影响解析", () => {
    expect(parsePartialReply('```json\n{"japanese_text":"おかえり。"').japaneseText).toBe("");
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
    expect(partial.japaneseText).toBe("");
  });

  it("语气字符串还没闭合时不采用，否则会先 neutral 再跳到 happy", () => {
    expect(parsePartialReply('{"mood":"hap').mood).toBe("neutral");
  });

  it("纯文本回复也有语气字段，值是 neutral", () => {
    expect(parsePartialReply("おかえり").mood).toBe("neutral");
  });

  it("先收到 canonical mood 和 replyText 时无需等完整 JSON", () => {
    const partial = parsePartialReply('{"mood":"happy","replyText":"你好，今');
    expect(partial.mood).toBe("happy");
    expect(partial.japaneseText).toBe("你好，今");
    expect(partial.japaneseComplete).toBe(false);
  });

  it("canonical translation 兼容 Unicode 转义分片", () => {
    const partial = parsePartialReply('{"mood":"neutral","replyText":"\u4f60\u597d","translation":"こんにちは"}');
    expect(partial.japaneseText).toBe("你好");
    expect(partial.chineseTranslation).toBe("こんにちは");
  });

  it("canonical 正文的 Unicode 转义跨片时只追加完整字符，不回退或重复", () => {
    const chunks = [
      String.raw`{"replyText":"\u4f`,
      String.raw`60\u597d"}`,
    ];
    let raw = "";
    const seen: string[] = [];
    for (const chunk of chunks) {
      raw += chunk;
      seen.push(parsePartialReply(raw).japaneseText);
    }

    expect(seen).toEqual(["", "你好"]);
    expect(seen[1].startsWith(seen[0])).toBe(true);
  });

  it("旧正文先到、canonical 后到时下游只看到 canonical 正文", () => {
    const chunks = [
      '{"japanese_text":"旧正文。",',
      '"replyText":"新正文。"}',
    ];
    let raw = "";
    const seen: string[] = [];
    for (const chunk of chunks) {
      raw += chunk;
      seen.push(parsePartialReply(raw).japaneseText);
    }

    expect(seen).toEqual(["", "新正文。"]);
    expect(seen.filter(Boolean)).toEqual(["新正文。"]);
  });

  it("嵌套 memory/action 的 replyText 不会被当成顶层正文", () => {
    const partial = parsePartialReply(
      '{"memoryCandidates":[{"replyText":"嵌套资料"}],"replyText":"顶层正文',
    );
    expect(partial.japaneseText).toBe("顶层正文");
  });

  it("Unicode 代理对跨片时不先发出孤立 surrogate", () => {
    const chunks = [
      String.raw`{"replyText":"前\uD83D`,
      String.raw`\uDE00后"}`,
    ];
    let raw = "";
    const seen: string[] = [];
    for (const chunk of chunks) {
      raw += chunk;
      seen.push(parsePartialReply(raw).japaneseText);
    }

    expect(seen).toEqual(["前", "前😀后"]);
    expect(seen[0]).toBe("前");
    expect(Array.from(seen[1])).toEqual(["前", "😀", "后"]);
  });

  it("canonical 非 string 存在时不回退旧正文", () => {
    expect(parsePartialReply('{"replyText":null,"japanese_text":"旧正文"}').japaneseText).toBe("");
  });
});
