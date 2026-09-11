import { describe, expect, it } from "vitest";
import {
  buildCompanionContext, companionMessage, displayTranslation, messageTurn, regeneratableTurn, retryableTurn,
  rewindPlan, toCompanionTurns, userMessage, WELCOME_MESSAGE_ID,
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

describe("retryableTurn", () => {
  /** 一轮失败在库里留下的两行：Runtime 落的用户消息 + Presenter 落的失败气泡，同号。 */
  function failedTurn(runtimeTurnId?: string): ChatMessage[] {
    return [
      { id: "asked", role: "user", content: "今天有点累", createdAt: NOW, time: "12:00", source: "text",
        ...(runtimeTurnId ? { runtimeTurnId } : {}) },
      { id: "failure", role: "assistant", content: "这次没有发出去：401", createdAt: NOW + 1, time: "12:00",
        error: true, ...(runtimeTurnId ? { runtimeTurnId } : {}) },
    ];
  }

  it("按 runtimeTurnId 归组：两行都要删，用原话重投", () => {
    expect(retryableTurn(failedTurn("run-1"), "failure")).toEqual({
      ids: ["asked", "failure"],
      text: "今天有点累",
      source: "text",
    });
  });

  it("旧数据没有 runtimeTurnId 时回退到最近一条用户消息", () => {
    const messages = [
      userMessage("更早说的", NOW - 10_000),
      companionMessage({ japaneseText: "うん", chineseTranslation: "嗯", mood: "neutral" }, NOW - 9000),
      ...failedTurn(),
    ];
    const turn = retryableTurn(messages, "failure");
    expect(turn?.text).toBe("今天有点累");
    expect(turn?.ids).toEqual(["failure", "asked"]);
  });

  it("同号的第三行也一起删，不留半轮", () => {
    const messages = [
      ...failedTurn("run-1"),
      { id: "fragment", role: "assistant" as const, content: "我刚才想说", createdAt: NOW + 2, time: "12:00",
        runtimeTurnId: "run-1", completion: "interrupted" as const },
    ];
    expect(retryableTurn(messages, "failure")?.ids).toEqual(["asked", "failure", "fragment"]);
  });

  it("语音轮重投仍标 voice，不伪装成打字", () => {
    const messages = failedTurn("run-1");
    messages[0] = { ...messages[0], source: "voice" };
    expect(retryableTurn(messages, "failure")?.source).toBe("voice");
  });

  it("不是失败的 assistant 消息一律不可重试", () => {
    const messages = failedTurn("run-1");
    expect(retryableTurn(messages, "asked")).toBeNull();
    expect(retryableTurn(messages, "不存在")).toBeNull();
    expect(retryableTurn([{ ...messages[1], error: false }], "failure")).toBeNull();
  });

  it("主动消息轮没有用户原话，返回 null 让界面不给入口", () => {
    // 主动消息不写用户历史（companionRuntime 的 source !== "proactive" 才落 asked）
    const messages: ChatMessage[] = [
      { id: "failure", role: "assistant", content: "这次没有发出去：401", createdAt: NOW, time: "12:00",
        error: true, runtimeTurnId: "run-1", source: "proactive" },
    ];
    expect(retryableTurn(messages, "failure")).toBeNull();
  });
});

describe("messageTurn", () => {
  /** 一轮成功的对话在库里留下的两行，同号。 */
  function okTurn(): ChatMessage[] {
    return [
      { id: "asked", role: "user", content: "今天有点累", createdAt: NOW, time: "12:00",
        source: "text", runtimeTurnId: "run-1" },
      { id: "replied", role: "assistant", content: "おつかれ", japaneseText: "おつかれ",
        chineseTranslation: "辛苦了", createdAt: NOW + 1, time: "12:00", runtimeTurnId: "run-1" },
    ];
  }

  it("从任一行都能找回整轮：assistant 进、user 进，结果一样", () => {
    const messages = okTurn();
    expect(messageTurn(messages, "replied")).toEqual({ ids: ["asked", "replied"], text: "今天有点累", source: "text" });
    expect(messageTurn(messages, "asked")?.ids).toEqual(["asked", "replied"]);
  });

  it("主动消息轮没有用户原话：ids 有它自己，text 是空串", () => {
    const messages: ChatMessage[] = [
      { id: "push", role: "assistant", content: "在做什么呢", createdAt: NOW, time: "12:00",
        source: "proactive", runtimeTurnId: "run-9" },
    ];
    expect(messageTurn(messages, "push")).toEqual({ ids: ["push"], text: "", source: "proactive" });
  });

  it("找不到这条消息就是 null，不猜", () => {
    expect(messageTurn(okTurn(), "不存在")).toBeNull();
  });
});

describe("regeneratableTurn", () => {
  function turn(overrides: Partial<ChatMessage> = {}): ChatMessage[] {
    return [
      { id: "asked", role: "user", content: "今天有点累", createdAt: NOW, time: "12:00",
        source: "text", runtimeTurnId: "run-1" },
      { id: "replied", role: "assistant", content: "おつかれ", createdAt: NOW + 1, time: "12:00",
        runtimeTurnId: "run-1", ...overrides },
    ];
  }

  it("成功的回复可以重新生成，删整轮后用原话重投", () => {
    expect(regeneratableTurn(turn(), "replied")).toEqual({
      ids: ["asked", "replied"], text: "今天有点累", source: "text",
    });
  });

  it("失败气泡走重试，不在这里出第二个按钮", () => {
    expect(regeneratableTurn(turn({ error: true }), "replied")).toBeNull();
  });

  it("还在生成中的那条不给：先让这一轮结束或取消它", () => {
    expect(regeneratableTurn(turn({ pending: true }), "replied")).toBeNull();
  });

  it("用户消息与主动消息轮都不可重新生成", () => {
    expect(regeneratableTurn(turn(), "asked")).toBeNull();
    const proactive: ChatMessage[] = [
      { id: "push", role: "assistant", content: "在做什么呢", createdAt: NOW, time: "12:00",
        source: "proactive", runtimeTurnId: "run-9" },
    ];
    expect(regeneratableTurn(proactive, "push")).toBeNull();
  });

  it("开场白不可重新生成：它前面没有用户原话", () => {
    const messages: ChatMessage[] = [
      { id: WELCOME_MESSAGE_ID, role: "assistant", content: "你回来了", createdAt: NOW, time: "12:00", source: "text" },
    ];
    expect(regeneratableTurn(messages, WELCOME_MESSAGE_ID)).toBeNull();
  });
});

describe("rewindPlan", () => {
  function history(): ChatMessage[] {
    return [
      { id: WELCOME_MESSAGE_ID, role: "assistant", content: "你回来了", createdAt: NOW - 5000, time: "11:58", source: "text" },
      { id: "u1", role: "user", content: "第一句", createdAt: NOW - 4000, time: "11:59", source: "text", runtimeTurnId: "run-1" },
      { id: "a1", role: "assistant", content: "うん", createdAt: NOW - 3000, time: "11:59", runtimeTurnId: "run-1" },
      { id: "u2", role: "user", content: "第二句", createdAt: NOW - 2000, time: "12:00", source: "text", runtimeTurnId: "run-2" },
      { id: "a2", role: "assistant", content: "そうだね", createdAt: NOW - 1000, time: "12:00", runtimeTurnId: "run-2" },
    ];
  }

  it("锚点保留，它之后的全部要删", () => {
    expect(rewindPlan(history(), "a1")).toEqual({ ids: ["u2", "a2"], anchorAt: NOW - 3000 });
  });

  it("回退到用户那句：这一轮的回复也在删除范围里", () => {
    expect(rewindPlan(history(), "u2")?.ids).toEqual(["a2"]);
  });

  it("锚点之后什么都没有时不给回退", () => {
    expect(rewindPlan(history(), "a2")).toBeNull();
  });

  it("开场白不是回退目标：回到它等于清空整个对话", () => {
    expect(rewindPlan(history(), WELCOME_MESSAGE_ID)).toBeNull();
  });

  it("开场白永远不在删除范围里——它从来不落库", () => {
    const withWelcomeLater: ChatMessage[] = [
      { id: "u1", role: "user", content: "第一句", createdAt: NOW - 4000, time: "11:59", source: "text" },
      { id: WELCOME_MESSAGE_ID, role: "assistant", content: "你回来了", createdAt: NOW - 3000, time: "11:59", source: "text" },
      { id: "a1", role: "assistant", content: "うん", createdAt: NOW - 2000, time: "12:00" },
    ];
    expect(rewindPlan(withWelcomeLater, "u1")?.ids).toEqual(["a1"]);
  });

  it("锚点不存在就是 null，不猜", () => {
    expect(rewindPlan(history(), "不存在")).toBeNull();
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
