import { describe, expect, it } from "vitest";
import type { CompanionContext } from "./companion";
import { buildConversationInput, buildInstructions, buildProactiveInput } from "./prompt";
import { computeRelationship, EMPTY_RELATIONSHIP_SIGNALS } from "./relationship";

function context(overrides: Partial<CompanionContext> = {}): CompanionContext {
  return {
    recentTurns: [],
    memories: [],
    summary: null,
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

  it("多语规则写成一个人，而不是几种可切换的模式", () => {
    const instructions = buildInstructions(context(), persona);
    expect(instructions).toContain("三种话对你没有主次之分");
    expect(instructions).toContain("一句话里混着说");
    // 不能再出现「默认某语言 / 满足条件才切换」这种模式化表述
    expect(instructions).not.toContain("默认用自然、口语化的日语");
  });

  it("中日英三种都在人设里", () => {
    const instructions = buildInstructions(context(), persona);
    expect(instructions).toContain("日语环境里长大");
    expect(instructions).toContain("中文同样是母语");
    expect(instructions).toContain("英语也说得很自然");
  });

  it("输出契约允许原话是任意一种语言或混说", () => {
    expect(buildInstructions(context(), persona)).toContain("日语、中文、英语或混着说都照原样写");
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

describe("摘要与主动理由注入", () => {
  it("有摘要时写进提示词，没有时不出现空段落", () => {
    const withSummary = buildInstructions(context({ summary: "上周聊过换工作的事。" }), persona);
    expect(withSummary).toContain("更早之前发生过什么");
    expect(withSummary).toContain("上周聊过换工作的事。");
    expect(buildInstructions(context(), persona)).not.toContain("更早之前发生过什么");
  });

  it("主动输入里带上这次想起对方的具体理由", () => {
    const input = buildProactiveInput(context(), {
      kind: "user-plan",
      hint: "对方提过下周要面试。不要索取回复，也不要制造负罪感。",
    });
    expect(input).toContain("这次想起对方的具体理由");
    expect(input).toContain("下周要面试");
  });

  it("不给理由时退回原来的主动输入", () => {
    expect(buildProactiveInput(context())).not.toContain("这次想起对方的具体理由");
  });
});

describe("提问规则：她可以问，但不能带人机味", () => {
  it("要求问题挂在具体的东西上", () => {
    const instructions = buildInstructions(context(), persona);
    expect(instructions).toContain("提问必须挂在具体的东西上");
    expect(instructions).toContain("先说你自己的事，再问对方的");
  });

  it("点名禁掉万能问句", () => {
    const instructions = buildInstructions(context(), persona);
    expect(instructions).toContain("今天怎么样");
    expect(instructions).toContain("在做什么呢");
    expect(instructions).toContain("一句都不要说");
  });

  it("不许连着两条都以问句结尾", () => {
    expect(buildInstructions(context(), persona)).toContain("上一条消息如果以问句结尾");
  });

  it("主动消息优先说具体的事，不用空问句开场", () => {
    const input = buildProactiveInput(context());
    expect(input).toContain("优先说一件具体的事");
    expect(input).toContain("可以完全不带问题");
    expect(input).toContain("不要用空问句开场");
  });

  it("反负罪感一行仍然逐字保留", () => {
    expect(buildProactiveInput(context())).toContain(
      "不要说“系统提醒”“学习任务”，不要索取回复，也不要制造负罪感。",
    );
  });
});

describe("buildInstructions 的表情包规则", () => {
  const stickers = [{ id: "wink", file: "wink.png", when: "开玩笑逗对方的时候" }];

  it("清单为空时提示词里一个字都不提", () => {
    // 素材还没放进目录时，行为必须和没有这个功能完全一样
    const instructions = buildInstructions(context(), persona);
    expect(instructions).not.toContain("表情包");
    expect(instructions).not.toContain("sticker");
  });

  it("有清单时列出选项，并把 sticker 字段写进输出格式", () => {
    const instructions = buildInstructions(context(), persona, stickers);
    expect(instructions).toContain("wink：开玩笑逗对方的时候");
    expect(instructions).toContain('"sticker"');
    expect(instructions).toContain("不要编造");
  });

  it("反模板句与提问规则不受影响", () => {
    const instructions = buildInstructions(context(), persona, stickers);
    expect(instructions).toContain("避免重复“我会一直陪着你”");
    expect(instructions).toContain("先说你自己的事，再问对方的。");
  });
});

describe("buildInstructions 的语气规则", () => {
  it("语气写在输出格式的第一个字段：流式时它要比正文先到", () => {
    const instructions = buildInstructions(context(), persona);
    expect(instructions).toContain('{"mood":"语气","japanese_text"');
  });

  it("七个语气都带使用场景，并写明标的是她自己的状态", () => {
    const instructions = buildInstructions(context(), persona);
    expect(instructions).toContain("- concerned：");
    expect(instructions).toContain("不是对方的心情");
  });
});
