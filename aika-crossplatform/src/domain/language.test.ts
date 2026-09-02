import { describe, expect, it } from "vitest";
import { detectLanguage, preferredRecognitionLanguage } from "./language";

describe("detectLanguage", () => {
  it("有假名就是日语", () => {
    expect(detectLanguage("今日は何してるの？")).toBe("ja");
  });

  it("只有汉字算中文", () => {
    expect(detectLanguage("今天想和你聊天")).toBe("zh");
  });

  it("纯拉丁字母算混合", () => {
    expect(detectLanguage("hello Aika")).toBe("mixed");
  });

  it("中日混说里只要有假名就按日语算", () => {
    expect(detectLanguage("今天ちょっと疲れた")).toBe("ja");
  });
});

describe("preferredRecognitionLanguage", () => {
  it("没有历史时默认日语", () => {
    expect(preferredRecognitionLanguage([])).toBe("ja-JP");
  });

  it("跟着用户最近说的语言走", () => {
    expect(preferredRecognitionLanguage(["おはよう", "今天有点累"])).toBe("zh-CN");
    expect(preferredRecognitionLanguage(["今天有点累", "でも大丈夫"])).toBe("ja-JP");
  });

  it("跳过判断不出语言的内容，看更早的一句", () => {
    expect(preferredRecognitionLanguage(["今天有点累", "ok", "hmm"])).toBe("zh-CN");
  });

  it("全都判断不出时用回退值", () => {
    expect(preferredRecognitionLanguage(["ok", "hmm"])).toBe("ja-JP");
    expect(preferredRecognitionLanguage(["ok"], "zh-CN")).toBe("zh-CN");
  });
});
