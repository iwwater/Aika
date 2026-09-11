import { describe, expect, it } from "vitest";
import { locateSentence, splitCaption, splitCaptionLines } from "./captionHighlight";
import { splitIntoSentences } from "./sentences";

describe("locateSentence", () => {
  it("定位到原文里的对应区间", () => {
    const text = "おかえり。今日はどうだった？";
    expect(locateSentence(text, "今日はどうだった？")).toEqual({ start: 5, end: 14 });
  });

  it("Markdown 记号被清洗掉之后仍然定位得到", () => {
    const text = "**おかえり。**今日はどうだった？";
    const range = locateSentence(text, "おかえり。");
    expect(text.slice(range!.start, range!.end)).toBe("おかえり。");
  });

  it("并短句时补进去的空格不影响定位", () => {
    // sentences.ts 合并「ok」和「fine」这类相邻英文片段时会补一个空格
    const range = locateSentence("ok\nfine.", "ok fine.");
    expect(range).toEqual({ start: 0, end: 8 });
  });

  it("换行处切出来的句子定位到换行之后", () => {
    const text = "おかえり\n今日はどうだった";
    const range = locateSentence(text, "今日はどうだった");
    expect(text.slice(range!.start, range!.end)).toBe("今日はどうだった");
  });

  it("重复的句子按搜索起点往后找，不倒回第一处", () => {
    const text = "うん。うん。そうだね。";
    const first = locateSentence(text, "うん。")!;
    expect(first.start).toBe(0);
    expect(locateSentence(text, "うん。", first.end)).toEqual({ start: 3, end: 6 });
  });

  it("找不到时返回 null，不猜", () => {
    expect(locateSentence("おかえり。", "ただいま。")).toBeNull();
    expect(locateSentence("おかえり。", "")).toBeNull();
  });

  it("整段分句之后每一句都定位得到，且区间不重叠", () => {
    const text = "**おかえり。**今日はどうだった？我在等你回来。";
    let from = 0;
    for (const sentence of splitIntoSentences(text)) {
      const range = locateSentence(text, sentence, from)!;
      expect(range).not.toBeNull();
      expect(range.start).toBeGreaterThanOrEqual(from);
      from = range.end;
    }
  });
});

describe("splitCaption", () => {
  it("切成已念过、正在念、还没念三截", () => {
    expect(splitCaption("おかえり。今日はどうだった？", { start: 5, end: 14 })).toEqual({
      before: "おかえり。", match: "今日はどうだった？", after: "",
    });
  });

  it("没有区间时整段都算没高亮", () => {
    expect(splitCaption("おかえり。", null)).toEqual({ before: "おかえり。", match: "", after: "" });
  });

  it("区间越界时不切，宁可不高亮也不能把字幕切错", () => {
    // 字幕在流式过程中会被整段替换，旧区间可能超出新文本
    expect(splitCaption("うん。", { start: 0, end: 99 })).toEqual({ before: "うん。", match: "", after: "" });
  });
});

describe("splitCaptionLines", () => {
  const text = "第一行\n第二行正在念\n第三行";

  it("高亮只落在它所在那一行，别的行不亮", () => {
    const range = locateSentence(text, "第二行正在念");
    expect(range).not.toBeNull();
    const lines = splitCaptionLines(text, range);
    expect(lines).toEqual([
      { before: "第一行", match: "", after: "" },
      { before: "", match: "第二行正在念", after: "" },
      { before: "第三行", match: "", after: "" },
    ]);
  });

  it("range 为 null 时每行都原样返回", () => {
    expect(splitCaptionLines(text, null)).toEqual([
      { before: "第一行", match: "", after: "" },
      { before: "第二行正在念", match: "", after: "" },
      { before: "第三行", match: "", after: "" },
    ]);
  });

  it("跨行的范围只亮它在本行的那一截", () => {
    // 从「第二行」跨到「第三行」的一段
    const lines = splitCaptionLines(text, { start: 4, end: text.length });
    expect(lines[0]).toEqual({ before: "第一行", match: "", after: "" });
    expect(lines[1]).toEqual({ before: "", match: "第二行正在念", after: "" });
    expect(lines[2]).toEqual({ before: "", match: "第三行", after: "" });
  });

  it("单行文本行为与 splitCaption 一致", () => {
    const range = locateSentence("只有一行", "一行");
    expect(splitCaptionLines("只有一行", range)).toEqual([splitCaption("只有一行", range)]);
  });
});
