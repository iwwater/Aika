import { describe, expect, it } from "vitest";
import {
  buildCompanionContext, companionMessage, displayTranslation, toCompanionTurns, userMessage,
  type ChatMessage,
} from "./conversation";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date(2026, 8, 2, 12, 0, 0).getTime();

function history(): ChatMessage[] {
  return [
    userMessage("おはよう", NOW - 3 * DAY),
    companionMessage({ japaneseText: "おはよ", chineseTranslation: "早", mood: "neutral" }, NOW - 3 * DAY + 1000),
    userMessage("今日は疲れた", NOW - 1000),
  ];
}

describe("displayTranslation", () => {
  function reply(japaneseText: string, chineseTranslation: string): ChatMessage {
    return companionMessage({ japaneseText, chineseTranslation, mood: "neutral" }, NOW);
  }

  it("翻译是另一句时照常显示", () => {
    expect(displayTranslation(reply("おかえり", "你回来了"))).toBe("你回来了");
  });

  it("翻译和正文是同一句时不显示第二层", () => {
    // 触发本次修复的那一轮：qwen-plus 把 replyText 和 translation 返回了同一句中文
    expect(displayTranslation(reply("今天有点累", "今天有点累"))).toBe("");
  });

  it("只差空白、标点或大小写仍算同一句", () => {
    expect(displayTranslation(reply("今天有点累。", "今天有点累"))).toBe("");
    expect(displayTranslation(reply("今天 有点累", "今天有点累！"))).toBe("");
    expect(displayTranslation(reply("I had a long day", "i had a long day."))).toBe("");
  });

  it("纯汉字的日语不按语言误杀字幕", () => {
    // detectLanguage 会把「大丈夫」判成 zh；按语言去字幕就会丢掉真正需要翻译的这几句
    expect(displayTranslation(reply("大丈夫", "没事的"))).toBe("没事的");
    expect(displayTranslation(reply("了解", "知道了"))).toBe("知道了");
  });

  it("没有翻译、或翻译只有空白时返回空串", () => {
    expect(displayTranslation(reply("おかえり", ""))).toBe("");
    expect(displayTranslation(reply("おかえり", "   "))).toBe("");
    expect(displayTranslation(userMessage("今日は疲れた", NOW))).toBe("");
  });

  it("失败气泡的正文在 content 里，同样参与判定", () => {
    const failure: ChatMessage = {
      id: "e", role: "assistant", content: "这次没有发出去：401",
      chineseTranslation: "这次没有发出去：401", createdAt: NOW, time: "12:00", error: true,
    };
    expect(displayTranslation(failure)).toBe("");
  });
});

describe("toCompanionTurns", () => {
  it("assistant 映射为 companion，并只带日语正文", () => {
    expect(toCompanionTurns(history())).toEqual([
      { role: "user", text: "おはよう" },
      { role: "companion", text: "おはよ" },
      { role: "user", text: "今日は疲れた" },
    ]);
  });

  it("跳过等待中和失败的消息", () => {
    const messages: ChatMessage[] = [
      ...history(),
      { id: "p", role: "assistant", content: "", createdAt: NOW, time: "12:00", pending: true },
      { id: "e", role: "assistant", content: "这次没有发出去", createdAt: NOW, time: "12:00", error: true },
    ];
    expect(toCompanionTurns(messages)).toHaveLength(3);
  });

  it("中断的 assistant 片段可落库但不作为完整回复进入上下文", () => {
    const messages: ChatMessage[] = [
      userMessage("你刚才说到哪里了？", NOW, 3),
      {
        id: "interrupted",
        role: "assistant",
        content: "我刚才想说",
        japaneseText: "我刚才想说",
        createdAt: NOW + 1,
        time: "12:00",
        turnId: 3,
        completion: "interrupted",
        playbackStatus: "unknown",
        source: "voice",
      },
    ];
    expect(toCompanionTurns(messages)).toEqual([
      { role: "user", text: "你刚才说到哪里了？" },
    ]);
  });
});

describe("buildCompanionContext", () => {
  it("带上记忆、摘要和多因子关系状态", () => {
    const context = buildCompanionContext({
      messages: history(),
      memories: ["偏好：喜欢傍晚散步"],
      summary: "上周聊过换工作的事。",
      now: NOW,
    });
    expect(context.memories).toEqual(["偏好：喜欢傍晚散步"]);
    expect(context.summary).toBe("上周聊过换工作的事。");
    expect(context.relationship.daysKnown).toBe(3);
    expect(context.relationship.totalMessageCount).toBe(3);
    expect(context.currentTimeInJapan).not.toBe("");
  });

  it("关系状态用完整时间戳，而不是只看当前窗口里的消息", () => {
    const timestamps = Array.from({ length: 400 }, (_, index) => NOW - index * 1000);
    const context = buildCompanionContext({ messages: history(), timestamps, now: NOW });
    expect(context.relationship.totalMessageCount).toBe(400);
  });

  it("没有摘要时 summary 为 null", () => {
    expect(buildCompanionContext({ messages: history(), now: NOW }).summary).toBeNull();
  });
});

describe("companionMessage", () => {
  it("主动消息带上 source，用于每日条数统计", () => {
    const message = companionMessage(
      { japaneseText: "ねえ", chineseTranslation: "喂", mood: "neutral" }, NOW, "id-1", "proactive",
    );
    expect(message.source).toBe("proactive");
    expect(message.japaneseText).toBe("ねえ");
  });
});
