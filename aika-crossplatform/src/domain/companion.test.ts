import { describe, expect, it } from "vitest";
import { companionReplySchema, parseCompanionReply, replyDisplayText } from "./companion";

describe("parseCompanionReply", () => {
  it("解析结构化双语输出", () => {
    expect(parseCompanionReply('{"japanese_text":"おかえり","chinese_translation":"你回来了"}')).toEqual({
      japaneseText: "おかえり",
      chineseTranslation: "你回来了",
      mood: "neutral",
    });
  });

  it("容忍 Markdown 代码块包裹", () => {
    const raw = '```json\n{"japanese_text":"うん","chinese_translation":"嗯"}\n```';
    expect(parseCompanionReply(raw).japaneseText).toBe("うん");
  });

  it("容忍 JSON 前后的多余文字", () => {
    const raw = 'ここです：{"japanese_text":"いいよ","chinese_translation":"好啊"} 以上';
    expect(parseCompanionReply(raw).chineseTranslation).toBe("好啊");
  });

  it("模型没按格式返回时整段当作日语正文，不丢这一轮", () => {
    expect(parseCompanionReply("今日はいい天気だね")).toEqual({
      japaneseText: "今日はいい天気だね",
      chineseTranslation: "",
      mood: "neutral",
    });
  });

  it("JSON 里缺少日语正文时退回原文", () => {
    expect(parseCompanionReply('{"chinese_translation":"只有翻译"}').japaneseText).toContain("只有翻译");
  });

  it("空回复返回空字段", () => {
    expect(parseCompanionReply("")).toEqual({ japaneseText: "", chineseTranslation: "", mood: "neutral" });
  });
});

describe("replyDisplayText", () => {
  it("优先日语正文，缺失时退回中文", () => {
    expect(replyDisplayText({ japaneseText: "ねえ", chineseTranslation: "喂", mood: "neutral" })).toBe("ねえ");
    expect(replyDisplayText({ japaneseText: "", chineseTranslation: "我在", mood: "neutral" })).toBe("我在");
  });
});

describe("companionReplySchema", () => {
  it("没有表情包时不加 sticker 字段", () => {
    const schema = companionReplySchema() as any;
    expect(Object.keys(schema.properties)).toEqual(["mood", "japanese_text", "chinese_translation"]);
    expect(schema.required).toEqual(["mood", "japanese_text", "chinese_translation"]);
  });

  it("有表情包时 sticker 是枚举，且带一个空串表示不发", () => {
    // strict 模式下每个属性都必须列进 required，「可选」只能靠空串表达
    const schema = companionReplySchema(["wink", "cry"]) as any;
    expect(schema.properties.sticker.enum).toEqual(["wink", "cry", ""]);
    expect(schema.required).toContain("sticker");
  });
});

describe("parseCompanionReply 的 sticker 字段", () => {
  it("取出她挑的表情包", () => {
    const raw = '{"japanese_text":"うん","chinese_translation":"嗯","sticker":"wink"}';
    expect(parseCompanionReply(raw).sticker).toBe("wink");
  });

  it("空串表示这一轮不发", () => {
    const raw = '{"japanese_text":"うん","chinese_translation":"嗯","sticker":""}';
    expect(parseCompanionReply(raw).sticker).toBeUndefined();
  });

  it("没有这个字段时照常解析", () => {
    expect(parseCompanionReply('{"japanese_text":"うん","chinese_translation":"嗯"}').sticker)
      .toBeUndefined();
  });
});

describe("mood 字段", () => {
  it("schema 里 mood 排在最前面：流式时它要比第一句正文先到", () => {
    const schema = companionReplySchema() as any;
    expect(Object.keys(schema.properties)[0]).toBe("mood");
    expect(schema.properties.mood.enum).toContain("concerned");
    expect(schema.required).toContain("mood");
  });

  it("解析出她标的语气", () => {
    const raw = '{"mood":"shy","japanese_text":"べつに","chinese_translation":"才没有"}';
    expect(parseCompanionReply(raw).mood).toBe("shy");
  });

  it("没有这个字段或编了个没见过的词时是 neutral", () => {
    expect(parseCompanionReply('{"japanese_text":"うん","chinese_translation":"嗯"}').mood).toBe("neutral");
    expect(parseCompanionReply('{"mood":"excited","japanese_text":"うん","chinese_translation":"嗯"}').mood)
      .toBe("neutral");
  });

  it("整段当正文的退路上也有语气，调用方不用判空", () => {
    expect(parseCompanionReply("おかえり").mood).toBe("neutral");
  });
});
