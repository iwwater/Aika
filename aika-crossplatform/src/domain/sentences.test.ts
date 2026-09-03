import { describe, expect, it } from "vitest";
import { createSentenceEmitter, MAX_SENTENCE_LENGTH, settledBoundary, splitIntoSentences } from "./sentences";

describe("splitIntoSentences", () => {
  it("按句末标点切分", () => {
    expect(splitIntoSentences("おかえり。今日はどうだった？お疲れさま。")).toEqual([
      "おかえり。", "今日はどうだった？", "お疲れさま。",
    ]);
  });

  it("连着的终止符和右引号跟着上一句", () => {
    expect(splitIntoSentences("本当に！？すごいじゃん。")).toEqual(["本当に！？", "すごいじゃん。"]);
    expect(splitIntoSentences("「もう寝るね。」おやすみなさい。")).toEqual(["「もう寝るね。」", "おやすみなさい。"]);
  });

  it("混说的回复按语言落在不同句子里", () => {
    // 逐句选音色的前提：中文那句要能单独拿出来
    expect(splitIntoSentences("うん、わかってる。我知道你今天很累了。")).toEqual([
      "うん、わかってる。", "我知道你今天很累了。",
    ]);
  });

  it("太短的片段并回上一句，不单独念", () => {
    expect(splitIntoSentences("ね。今日はゆっくり休んでね。")).toEqual(["ね。今日はゆっくり休んでね。"]);
    expect(splitIntoSentences("今日はゆっくり休んでね。うん。")).toEqual(["今日はゆっくり休んでね。うん。"]);
  });

  it("小数不会被当成句号切开", () => {
    expect(splitIntoSentences("体温は37.5度だった。")).toEqual(["体温は37.5度だった。"]);
  });

  it("换行当作分句，但不留在朗读文本里", () => {
    expect(splitIntoSentences("おかえり\n今日はどうだった")).toEqual(["おかえり", "今日はどうだった"]);
  });

  it("去掉 Markdown 记号，它们念出来是杂音", () => {
    expect(splitIntoSentences("**おかえり。**")).toEqual(["おかえり。"]);
  });

  it("过长且没有句末标点的段落在读点处再切，第一句才能早点开口", () => {
    const long = `今日はね${"、ずっと会社で新しいプロジェクトの資料を作っていた".repeat(4)}`;
    const parts = splitIntoSentences(long);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.join("")).toBe(long);
    expect(parts[0].replace(/\s+/g, "").length).toBeLessThanOrEqual(MAX_SENTENCE_LENGTH + 24);
  });

  it("空文本返回空数组", () => {
    expect(splitIntoSentences("")).toEqual([]);
    expect(splitIntoSentences("   \n  ")).toEqual([]);
  });

  it("不丢字：拼回去等于清理后的原文", () => {
    const text = "おかえり。今日はどうだった？我知道你很累了，先休息一下吧。Take your time.";
    expect(splitIntoSentences(text).join("")).toBe(text);
  });
});

describe("createSentenceEmitter", () => {
  it("只交出句末标点之前的内容，后面那截可能还在写", () => {
    const emitter = createSentenceEmitter();
    expect(emitter.push("おかえり。今日はど", false)).toEqual(["おかえり。"]);
    expect(emitter.push("おかえり。今日はどうだった？", false)).toEqual(["今日はどうだった？"]);
  });

  it("没有句末标点时什么都不交出去", () => {
    const emitter = createSentenceEmitter();
    expect(emitter.push("おかえ", false)).toEqual([]);
    expect(emitter.push("おかえり", false)).toEqual([]);
  });

  it("finished 时把剩下的全交出来", () => {
    const emitter = createSentenceEmitter();
    expect(emitter.push("おかえり。今日はどうだった", false)).toEqual(["おかえり。"]);
    expect(emitter.push("おかえり。今日はどうだった", true)).toEqual(["今日はどうだった"]);
  });

  it("太短的尾句留着等下一批，不单独念", () => {
    const emitter = createSentenceEmitter();
    expect(emitter.push("うん。", false)).toEqual([]);
    expect(emitter.push("うん。今日はゆっくり休んでね。", false)).toEqual(["うん。今日はゆっくり休んでね。"]);
  });

  it("逐字喂入也不重不漏", () => {
    const text = "おかえり。今日はどうだった？我知道你很累了。";
    const emitter = createSentenceEmitter();
    const emitted: string[] = [];
    for (let index = 1; index <= text.length; index += 1) {
      emitted.push(...emitter.push(text.slice(0, index), false));
    }
    emitted.push(...emitter.push(text, true));
    expect(emitted.join("")).toBe(text);
  });

  it("混说的回复逐句交出，音色才切得开", () => {
    const emitter = createSentenceEmitter();
    expect(emitter.push("うん、わかってる。我知道你今天很累了。Take", false)).toEqual([
      "うん、わかってる。", "我知道你今天很累了。",
    ]);
  });
});

describe("settledBoundary", () => {
  it("停在最后一个句末标点之后", () => {
    expect(settledBoundary("おかえり。今日は")).toBe(5);
    expect(settledBoundary("本当に！？すごい")).toBe(5);
  });

  it("没有句末标点时是 0", () => {
    expect(settledBoundary("おかえり")).toBe(0);
  });
});
