import { describe, expect, it } from "vitest";
import { buildCompanionContext, companionMessage, toCompanionTurns, userMessage, type ChatMessage } from "./conversation";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date(2026, 8, 2, 12, 0, 0).getTime();

function history(): ChatMessage[] {
  return [
    userMessage("おはよう", NOW - 3 * DAY),
    companionMessage({ japaneseText: "おはよ", chineseTranslation: "早" }, NOW - 3 * DAY + 1000),
    userMessage("今日は疲れた", NOW - 1000),
  ];
}

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
      { japaneseText: "ねえ", chineseTranslation: "喂" }, NOW, "id-1", "proactive",
    );
    expect(message.source).toBe("proactive");
    expect(message.japaneseText).toBe("ねえ");
  });
});
