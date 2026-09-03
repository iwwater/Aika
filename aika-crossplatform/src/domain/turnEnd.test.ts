import { describe, expect, it } from "vitest";
import {
  DEFAULT_TURN_END_SETTINGS, endpointHint, mergeFragment, shouldSubmit, silenceBudgetMs,
} from "./turnEnd";

describe("endpointHint", () => {
  it("句末标点算说完了", () => {
    expect(endpointHint("今日は疲れた。")).toBe("settled");
    expect(endpointHint("你今天做什么了？")).toBe("settled");
    expect(endpointHint("How was your day?")).toBe("settled");
    expect(endpointHint("「もう寝るね。」")).toBe("settled");
  });

  it("小数点不是句号", () => {
    expect(endpointHint("体温は37.5")).not.toBe("settled");
  });

  it("填充词和连接词结尾算没说完", () => {
    expect(endpointHint("今日はえーと")).toBe("unsettled");
    expect(endpointHint("我今天就是")).toBe("unsettled");
    expect(endpointHint("I went there and")).toBe("unsettled");
    expect(endpointHint("昨日はね、")).toBe("unsettled");
  });

  it("以填充词结尾的判断要看词边界", () => {
    // 「also」不是以英语填充词 so 结尾
    expect(endpointHint("that works also")).not.toBe("unsettled");
  });

  it("太短的片段当成还没说完，宁可多等也不抢话", () => {
    expect(endpointHint("あ")).toBe("unsettled");
    expect(endpointHint("那个")).toBe("unsettled");
  });

  it("终助词和语气词结尾算说完了", () => {
    expect(endpointHint("今日は楽しかったよ")).toBe("settled");
    expect(endpointHint("明日また話そうね")).toBe("settled");
    expect(endpointHint("我已经吃过了")).toBe("settled");
  });

  it("判断不出来时保持中立，用基准等待", () => {
    expect(endpointHint("今日は会社で新しいプロジェクト")).toBe("neutral");
    expect(silenceBudgetMs("今日は会社で新しいプロジェクト")).toBe(DEFAULT_TURN_END_SETTINGS.baseSilenceMs);
  });
});

describe("silenceBudgetMs", () => {
  it("基准等待落在方案定的 1.2～1.5 秒", () => {
    expect(DEFAULT_TURN_END_SETTINGS.baseSilenceMs).toBeGreaterThanOrEqual(1200);
    expect(DEFAULT_TURN_END_SETTINGS.baseSilenceMs).toBeLessThanOrEqual(1500);
  });

  it("没说完时等更久，说完了就少等", () => {
    const unsettled = silenceBudgetMs("今日はえーと");
    const settled = silenceBudgetMs("今日は疲れた。");
    expect(unsettled).toBeGreaterThan(DEFAULT_TURN_END_SETTINGS.baseSilenceMs);
    expect(settled).toBeLessThan(DEFAULT_TURN_END_SETTINGS.baseSilenceMs);
  });

  it("再犹豫也不超过兜底上限", () => {
    const tight = { ...DEFAULT_TURN_END_SETTINGS, maxSilenceMs: 1500 };
    expect(silenceBudgetMs("今日はえーと", tight)).toBe(1500);
  });
});

describe("shouldSubmit", () => {
  it("缓冲区为空时不提交：静音本身不是一轮", () => {
    expect(shouldSubmit("", 9000)).toBe(false);
    expect(shouldSubmit("   ", 9000)).toBe(false);
  });

  it("P0 验收：句中停顿 900 毫秒不提交", () => {
    expect(shouldSubmit("今日は会社で", 900)).toBe(false);
  });

  it("犹豫词后面停 2 秒也不提交，用户还在想", () => {
    expect(shouldSubmit("今日はえーと", 2000)).toBe(false);
    expect(shouldSubmit("今日はえーと", 2500)).toBe(true);
  });

  it("说完了就不必等满基准", () => {
    expect(shouldSubmit("今日は疲れた。", 1200)).toBe(true);
    expect(shouldSubmit("今日は疲れた。", 1000)).toBe(false);
  });

  it("到了兜底上限一律提交，不能卡死", () => {
    expect(shouldSubmit("今日はえーと", DEFAULT_TURN_END_SETTINGS.maxSilenceMs)).toBe(true);
  });
});

describe("mergeFragment", () => {
  it("中日文片段直接相接，不插空格", () => {
    expect(mergeFragment("今日は", "会社で残業してた")).toBe("今日は会社で残業してた");
    expect(mergeFragment("我今天", "有点累")).toBe("我今天有点累");
  });

  it("英文片段之间补空格", () => {
    expect(mergeFragment("I was", "really tired")).toBe("I was really tired");
  });

  it("中日英混说时按接缝两侧决定要不要空格", () => {
    expect(mergeFragment("今日はちょっと", "busy")).toBe("今日はちょっとbusy");
    expect(mergeFragment("really", "疲れた")).toBe("really疲れた");
  });

  it("空片段不改变缓冲区", () => {
    expect(mergeFragment("今日は", "  ")).toBe("今日は");
    expect(mergeFragment("", "今日は")).toBe("今日は");
  });
});

describe("一轮完整对话的模拟", () => {
  /** 按时间轴喂片段，返回一共提交了几次。验收线是「一次停顿不拆成两次请求」。 */
  function runTurn(events: Array<{ atMs: number; text: string }>, endAtMs: number): string[] {
    const submitted: string[] = [];
    let buffer = "";
    let lastVoiceAt = 0;
    const timeline = [...events].sort((left, right) => left.atMs - right.atMs);
    let cursor = 0;

    for (let now = 0; now <= endAtMs; now += 50) {
      while (cursor < timeline.length && timeline[cursor].atMs <= now) {
        buffer = mergeFragment(buffer, timeline[cursor].text);
        lastVoiceAt = now;
        cursor += 1;
      }
      if (shouldSubmit(buffer, now - lastVoiceAt)) {
        submitted.push(buffer);
        buffer = "";
      }
    }
    return submitted;
  }

  it("句中停顿 1 秒后继续说，仍然只发一次请求", () => {
    const submitted = runTurn(
      [
        { atMs: 0, text: "今日は会社で" },
        { atMs: 1000, text: "新しいプロジェクトが始まった。" },
      ],
      6000,
    );
    expect(submitted).toEqual(["今日は会社で新しいプロジェクトが始まった。"]);
  });

  it("犹豫词加长停顿也不拆", () => {
    const submitted = runTurn(
      [
        { atMs: 0, text: "えーと" },
        { atMs: 1800, text: "今日はちょっと疲れた。" },
      ],
      7000,
    );
    expect(submitted).toEqual(["えーと今日はちょっと疲れた。"]);
  });

  it("中日英混说分三段识别，合成一轮", () => {
    const submitted = runTurn(
      [
        { atMs: 0, text: "今日は" },
        { atMs: 800, text: "really" },
        { atMs: 1500, text: "疲れた。" },
      ],
      6000,
    );
    expect(submitted).toEqual(["今日はreally疲れた。"]);
  });

  it("真的说完两轮时才提交两次", () => {
    const submitted = runTurn(
      [
        { atMs: 0, text: "おはよう。" },
        { atMs: 4000, text: "今日は何してるの？" },
      ],
      8000,
    );
    expect(submitted).toEqual(["おはよう。", "今日は何してるの？"]);
  });
});
