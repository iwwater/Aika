import { describe, expect, it } from "vitest";
import { detectLanguage, preferredRecognitionLanguage, speechLanguageFor } from "./language";

describe("detectLanguage", () => {
  it("有假名就是日语", () => {
    expect(detectLanguage("今日は何してるの？")).toBe("ja");
  });

  it("只有汉字算中文", () => {
    expect(detectLanguage("今天想和你聊天")).toBe("zh");
  });

  it("纯拉丁字母算英语", () => {
    expect(detectLanguage("hello, how was your day?")).toBe("en");
  });

  it("混着说时按最能确定语言的文字系统算", () => {
    // 假名只有日语用，所以夹英文单词的日语仍是日语
    expect(detectLanguage("今日はちょっとbusyだった")).toBe("ja");
    // 汉字在没有假名时才算中文，夹英文单词的中文仍是中文
    expect(detectLanguage("我今天有点busy")).toBe("zh");
  });

  it("没有可判断的文字时返回 unknown", () => {
    expect(detectLanguage("...!?")).toBe("unknown");
    expect(detectLanguage("")).toBe("unknown");
  });
});

describe("preferredRecognitionLanguage", () => {
  it("没有历史时默认日语", () => {
    expect(preferredRecognitionLanguage([])).toBe("ja-JP");
  });

  it("跟着用户最近说的语言走，中日英都跟", () => {
    expect(preferredRecognitionLanguage(["おはよう", "今天有点累"])).toBe("zh-CN");
    expect(preferredRecognitionLanguage(["今天有点累", "でも大丈夫"])).toBe("ja-JP");
    expect(preferredRecognitionLanguage(["おはよう", "I had a long day"])).toBe("en-US");
  });

  it("跳过判断不出语言的内容，看更早的一句", () => {
    expect(preferredRecognitionLanguage(["今天有点累", "...", "?!"])).toBe("zh-CN");
  });

  it("全都判断不出时用回退值", () => {
    expect(preferredRecognitionLanguage(["...", "?!"])).toBe("ja-JP");
    expect(preferredRecognitionLanguage(["..."], "zh-CN")).toBe("zh-CN");
  });
});

describe("speechLanguageFor", () => {
  it("她用哪种语言说的就用哪种语言念", () => {
    expect(speechLanguageFor("おかえり。今日はどうだった？")).toBe("ja-JP");
    expect(speechLanguageFor("先休息一下吧。")).toBe("zh-CN");
    expect(speechLanguageFor("Take your time.")).toBe("en-US");
  });

  it("念不出语言时退回日语音色", () => {
    expect(speechLanguageFor("……")).toBe("ja-JP");
  });
});
