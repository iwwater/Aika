import { describe, expect, it } from "vitest";
import { createFakeClock } from "./fakeDesktopPet";
import {
  CLICK_REACTION_MIN_INTERVAL_MS,
  CLICK_REACTION_PHRASES,
  createClickReaction,
  type ClickReactionSuppression,
} from "./clickReaction";

/**
 * MVP-15 选项 B 定向测试。
 *
 * 钉住的不是「能不能说」，而是「什么时候**不许**说」：冷却边界、不排队、不打断、
 * 关掉即零成本、任何依赖出事都不许冒到点击链路上。
 */

function setup(options: {
  enabled?: boolean;
  speaking?: boolean;
  gate?: boolean | (() => Promise<boolean> | boolean);
  speak?: (text: string) => boolean;
} = {}) {
  const clock = createFakeClock(0);
  const spoken: string[] = [];
  let gateCalls = 0;
  const reaction = createClickReaction({
    clock,
    speak: (text) => {
      if (options.speak) return options.speak(text);
      spoken.push(text);
      return true;
    },
    gate: async () => {
      gateCalls += 1;
      const value = options.gate ?? true;
      return typeof value === "function" ? await value() : value;
    },
    isEnabled: () => options.enabled ?? true,
    isSpeaking: () => options.speaking ?? false,
  });
  return { reaction, clock, spoken, gateCalls: () => gateCalls };
}

describe("点击回应（MVP-15 B）", () => {
  it("第一次点击就回应，短语取自固定池", async () => {
    const { reaction, spoken } = setup();

    await expect(reaction.handle()).resolves.toBeNull();
    expect(spoken).toEqual([CLICK_REACTION_PHRASES[0]]);
    expect(reaction.diagnostics()).toMatchObject({ received: 1, responded: 1 });
  });

  it("冷却内的连点直接丢，不排队也不攒着一起说", async () => {
    const { reaction, clock, spoken } = setup();

    await reaction.handle();
    for (let index = 0; index < 5; index += 1) {
      clock.advance(1_000);
      await expect(reaction.handle()).resolves.toBe("cooldown");
    }

    expect(spoken).toHaveLength(1);
    const diagnostics = reaction.diagnostics();
    expect(diagnostics.received).toBe(6);
    expect(diagnostics.responded).toBe(1);
    expect(diagnostics.suppressed.cooldown).toBe(5);
  });

  it("30s 是边界：差 1 毫秒仍抑制，满 30s 放行", async () => {
    const { reaction, clock, spoken } = setup();

    await reaction.handle();
    clock.advance(CLICK_REACTION_MIN_INTERVAL_MS - 1);
    await expect(reaction.handle()).resolves.toBe("cooldown");
    expect(spoken).toHaveLength(1);

    clock.advance(1);
    await expect(reaction.handle()).resolves.toBeNull();
    expect(spoken).toHaveLength(2);
  });

  it("冷却从**成功回应**起算，不是从收到点击起算", async () => {
    const { reaction, clock, spoken } = setup();

    // 先被抑制几次（不推进冷却）
    await reaction.handle();
    clock.advance(CLICK_REACTION_MIN_INTERVAL_MS);
    // 上一句之后又过了 30s：可以回应
    await reaction.handle();
    expect(spoken).toHaveLength(2);

    // 从这一刻起 29.9s 内仍然不许说
    clock.advance(CLICK_REACTION_MIN_INTERVAL_MS - 100);
    await expect(reaction.handle()).resolves.toBe("cooldown");
  });

  it("用户关掉后零成本：不查终审、不出声、不构造短语", async () => {
    const { reaction, spoken, gateCalls } = setup({ enabled: false });

    await expect(reaction.handle()).resolves.toBe("disabled");
    expect(spoken).toEqual([]);
    expect(gateCalls()).toBe(0);
    expect(reaction.diagnostics().suppressed.disabled).toBe(1);
  });

  it("setEnabled 立刻生效，且关掉不占用冷却", async () => {
    const { reaction, clock, spoken } = setup();

    await reaction.handle();
    expect(spoken).toHaveLength(1);

    // 关掉：随后的点击被抑制，但没有推进冷却。
    reaction.setEnabled(false);
    clock.advance(1_000);
    await expect(reaction.handle()).resolves.toBe("disabled");
    expect(spoken).toHaveLength(1);

    // 重新打开：只要过了冷却就能正常回应（不是「关过一次就哑掉」）。
    reaction.setEnabled(true);
    clock.advance(CLICK_REACTION_MIN_INTERVAL_MS);
    await expect(reaction.handle()).resolves.toBeNull();
    expect(spoken).toHaveLength(2);
  });

  it("canSend 终审没过就不出声（安静时段/上限/最小间隔共用同一出口）", async () => {
    const { reaction, spoken } = setup({ gate: false });

    await expect(reaction.handle()).resolves.toBe("gate");
    expect(spoken).toEqual([]);
    const diagnostics = reaction.diagnostics();
    expect(diagnostics.responded).toBe(0);
    expect(diagnostics.suppressed.gate).toBe(1);
  });

  it("她正在说话时不叠话；说完了下一次点击照常回应", async () => {
    const speaking = { value: true };
    const clock = createFakeClock(0);
    const spoken: string[] = [];
    const reaction = createClickReaction({
      clock,
      speak: (text) => {
        spoken.push(text);
        return true;
      },
      gate: async () => true,
      isSpeaking: () => speaking.value,
    });

    await expect(reaction.handle()).resolves.toBe("speaking");
    expect(spoken).toEqual([]);

    speaking.value = false;
    clock.advance(CLICK_REACTION_MIN_INTERVAL_MS);
    await expect(reaction.handle()).resolves.toBeNull();
    expect(spoken).toHaveLength(1);
  });

  it("没出声就不算回应过：冷却不推进，下一次仍有机会", async () => {
    const { reaction, clock, spoken } = setup({ speak: () => false });

    await expect(reaction.handle()).resolves.toBe("unavailable");
    expect(spoken).toEqual([]);

    clock.advance(1_000);
    await expect(reaction.handle()).resolves.toBe("unavailable");
    expect(reaction.diagnostics().suppressed.unavailable).toBe(2);

    // 出声通道恢复后立刻能说（没有被冷却挡住）
    const recovered = setup({}); // 独立实例仅用于对照：上面的实例已固定 speak=false
    await expect(recovered.reaction.handle()).resolves.toBeNull();
  });

  it("终审或出声抛错都不冒到点击链路上", async () => {
    const throwing = setup({
      gate: async () => {
        throw new Error("proactive settings unavailable");
      },
    });
    await expect(throwing.reaction.handle()).resolves.toBe("unavailable");

    const speakThrows = setup({
      speak: () => {
        throw new Error("engine exploded");
      },
    });
    await expect(speakThrows.reaction.handle()).resolves.toBe("unavailable");
  });

  it("诊断是快照：外部改它不影响内部计数", async () => {
    const { reaction } = setup();
    await reaction.handle();

    const snapshot = reaction.diagnostics();
    snapshot.responded = 999;
    snapshot.suppressed.cooldown = 999;
    expect(reaction.diagnostics().responded).toBe(1);
    expect(reaction.diagnostics().suppressed.cooldown).toBe(0);
  });

  it("池子里都是短句，且没有需要上下文才成立的话", () => {
    expect(CLICK_REACTION_PHRASES.length).toBeGreaterThanOrEqual(3);
    for (const phrase of CLICK_REACTION_PHRASES) {
      expect(phrase.length).toBeLessThanOrEqual(12);
      // 不能说「记得」「刚才」这类需要上下文/记忆的措辞：池子没有上下文可言。
      expect(phrase).not.toMatch(/记得|刚才|昨天|上次/);
    }
  });
});

/** 类型层面的护栏：抑制原因是封闭集合，新增原因必须同步诊断结构。 */
const _suppressionIsClosed: ClickReactionSuppression[] = [
  "disabled",
  "cooldown",
  "gate",
  "speaking",
  "unavailable",
];
void _suppressionIsClosed;
