import { describe, expect, it } from "vitest";
import type { CompanionContext } from "./companion";
import { buildConversationInput, buildInstructions, buildProactiveInput } from "./prompt";
import { computeRelationship, EMPTY_RELATIONSHIP_SIGNALS } from "./relationship";

function context(overrides: Partial<CompanionContext> = {}): CompanionContext {
  return {
    recentTurns: [],
    memories: [],
    relationship: computeRelationship(EMPTY_RELATIONSHIP_SIGNALS),
    currentTimeInJapan: "2026-09-02 星期三 21:30",
    ...overrides,
  };
}

const persona = "你是 Aika，一个明确属于虚构作品的电子女友角色。";

describe("buildInstructions", () => {
  it("不包含任何教学残留", () => {
    const instructions = buildInstructions(context(), persona);
    expect(instructions).not.toContain("JLPT");
    expect(instructions).not.toContain("纠错");
    expect(instructions).not.toContain("接触日语");
  });

  it("包含 code-switch 规则", () => {
    expect(buildInstructions(context(), persona)).toContain("整句用中文回应");
  });

  it("保留反模板句规则", () => {
    const instructions = buildInstructions(context(), persona);
    expect(instructions).toContain("不要炫耀自己记得");
    expect(instructions).toContain("我会一直陪着你");
  });

  it("要求结构化双语输出", () => {
    const instructions = buildInstructions(context(), persona);
    expect(instructions).toContain("japanese_text");
    expect(instructions).toContain("chinese_translation");
  });

  it("注入时间、关系与记忆", () => {
    const instructions = buildInstructions(
      context({ memories: ["偏好：喜欢傍晚散步"] }),
      persona,
    );
    expect(instructions).toContain("2026-09-02 星期三 21:30");
    expect(instructions).toContain("刚开始熟悉");
    expect(instructions).toContain("偏好：喜欢傍晚散步");
  });

  it("没有记忆时不出现空的记忆段落", () => {
    expect(buildInstructions(context(), persona)).not.toContain("可参考的长期记忆");
  });
});

describe("buildConversationInput", () => {
  it("空历史时给出明确占位", () => {
    expect(buildConversationInput("ただいま", context())).toContain("（还没有历史对话）");
  });

  it("按说话人标注最近对话", () => {
    const input = buildConversationInput("うん", context({
      recentTurns: [
        { role: "user", text: "おはよう" },
        { role: "companion", text: "おはよ、よく眠れた？" },
      ],
    }));
    expect(input).toContain("用户：おはよう");
    expect(input).toContain("Aika：おはよ、よく眠れた？");
    expect(input).toContain("用户刚刚说：\nうん");
  });
});

describe("buildProactiveInput", () => {
  it("逐字保留反负罪感一行", () => {
    expect(buildProactiveInput(context())).toContain(
      "不要说“系统提醒”“学习任务”，不要索取回复，也不要制造负罪感。",
    );
  });

  it("只带最近十二轮", () => {
    const turns = Array.from({ length: 20 }, (_, index) => ({ role: "user" as const, text: `第${index}句` }));
    const input = buildProactiveInput(context({ recentTurns: turns }));
    expect(input).not.toContain("第7句");
    expect(input).toContain("第8句");
    expect(input).toContain("第19句");
  });
});
