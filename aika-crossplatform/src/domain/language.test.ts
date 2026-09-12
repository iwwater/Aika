import { describe, expect, it } from "vitest";
import { detectLanguage, nextRecognitionLanguage, recognitionSignal, speechLanguageFor } from "./language";

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

describe("recognitionSignal", () => {
  it("假名与日语专用字形是日语证据（STT-04-A）", () => {
    expect(recognitionSignal("今日は忙しかった")).toBe("ja");
    // 没有假名，但字形只有日语在用
    expect(recognitionSignal("元気")).toBe("ja");
    expect(recognitionSignal("一緒")).toBe("ja");
    expect(recognitionSignal("時間")).toBe("ja");
    expect(recognitionSignal("電話")).toBe("ja");
  });

  it("简体专用字形是中文证据（STT-04-A）", () => {
    expect(recognitionSignal("这样啊")).toBe("zh");
    expect(recognitionSignal("我们去吃饭")).toBe("zh");
    expect(recognitionSignal("他说了什么")).toBe("zh");
  });

  it("中日共用的纯汉字不作数（STT-04-A）", () => {
    // 这些全是日语，但字形中日一样；判不出就说判不出，不能拿它们切语言
    for (const text of ["大丈夫", "今日", "明日", "最近", "全部", "本当", "写真", "仕事", "先生", "学校"]) {
      expect(recognitionSignal(text), text).toBe("none");
    }
    // 同样的字形写成中文也一样不作数
    expect(recognitionSignal("今天有点累")).toBe("none");
  });

  it("纯拉丁字母是英语证据，夹汉字就不是（STT-04-A）", () => {
    expect(recognitionSignal("how was your day")).toBe("en");
    expect(recognitionSignal("我今天有点busy")).toBe("none");
  });

  it("空串与纯标点没有证据（STT-04-A）", () => {
    expect(recognitionSignal("")).toBe("none");
    expect(recognitionSignal("...!?")).toBe("none");
  });
});

describe("nextRecognitionLanguage", () => {
  const spoken = (...texts: string[]) => texts.map((text) => ({ text, fromVoice: true }));

  it("没有任何历史时用上一次用过的语言，默认日语（STT-04-C）", () => {
    expect(nextRecognitionLanguage([], [])).toBe("ja-JP");
    expect(nextRecognitionLanguage([], [], "zh-CN")).toBe("zh-CN");
  });

  it("没有假名的日语不再把语言切到中文（STT-04-B）", () => {
    // 改动前：这三句都被判成 zh，下一段就改用 zh-CN 听日语——自锁的入口
    expect(nextRecognitionLanguage(spoken("大丈夫", "今日", "本当"), [], "ja-JP")).toBe("ja-JP");
  });

  it("拿到确凿证据才切，中日英都跟（STT-04-B）", () => {
    expect(nextRecognitionLanguage(spoken("我们去吃饭"), [], "ja-JP")).toBe("zh-CN");
    expect(nextRecognitionLanguage(spoken("でも大丈夫"), [], "zh-CN")).toBe("ja-JP");
    expect(nextRecognitionLanguage(spoken("I had a long day"), [], "ja-JP")).toBe("en-US");
  });

  it("跳过没证据的，看更早的一句（STT-04-C）", () => {
    expect(nextRecognitionLanguage(spoken("我们去吃饭", "大丈夫", "..."), [], "ja-JP")).toBe("zh-CN");
  });

  it("有语音历史时不看打字内容，哪怕打字更新（STT-04-C）", () => {
    // 真实场景：先说了日语，再用键盘敲一句中文，然后接着说日语。
    // 打字那句是最新的，但它不该让下一段日语按中文听——排在后面也不行。
    expect(nextRecognitionLanguage(spoken("こんばんは"), ["我们去吃饭"], "ja-JP")).toBe("ja-JP");
    // 语音那几句全都没证据时也不能倒回去拿打字的：保持当前，不是改成中文
    expect(nextRecognitionLanguage(spoken("大丈夫", "今日"), ["我们去吃饭"], "ja-JP")).toBe("ja-JP");
  });

  it("一条语音历史都没有时才用打字内容当起点（STT-04-C）", () => {
    expect(nextRecognitionLanguage([], ["我们去吃饭"], "ja-JP")).toBe("zh-CN");
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

describe("speechLanguageFor · STT-04", () => {
  it("没有假名的日语不再用中文音色念（STT-04-E）", () => {
    expect(speechLanguageFor("電話")).toBe("ja-JP");
    expect(speechLanguageFor("元気")).toBe("ja-JP");
  });

  it("拿不到日语证据时行为与改动前一致（STT-04-E）", () => {
    expect(speechLanguageFor("先休息一下吧。")).toBe("zh-CN");
    expect(speechLanguageFor("Take your time.")).toBe("en-US");
    expect(speechLanguageFor("……")).toBe("ja-JP");
  });
});

