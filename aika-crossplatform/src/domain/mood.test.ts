import { describe, expect, it } from "vitest";
import { MOOD_RULES, MOODS, normalizeMood, speechToneFor } from "./mood";

describe("normalizeMood", () => {
  it("认得词表里的语气", () => {
    expect(normalizeMood("concerned")).toBe("concerned");
    expect(normalizeMood(" Happy ")).toBe("happy");
  });

  it("认不出来一律 neutral，不因为一个错字丢掉整轮回复", () => {
    // 不支持结构化输出的协议会整个字段都没有，或者给个没见过的词
    expect(normalizeMood("excited")).toBe("neutral");
    expect(normalizeMood(undefined)).toBe("neutral");
    expect(normalizeMood(42)).toBe("neutral");
  });
});

describe("MOODS", () => {
  it("就是 Live2D 那七个表情预设的文件名，不多不少", () => {
    // output/live2d/runtime-presets/expressions/ 下的七个 .exp3.json
    expect([...MOODS]).toEqual([
      "neutral", "gentle_smile", "happy", "shy", "surprised", "thinking", "concerned",
    ]);
  });
});

describe("speechToneFor", () => {
  it("每个语气都有一组朗读参数", () => {
    for (const mood of MOODS) {
      const tone = speechToneFor(mood);
      expect(tone.rate).toBeGreaterThan(0);
      expect(tone.pitch).toBeGreaterThan(0);
    }
  });

  it("幅度很小：调大了不像情绪，像换了个人", () => {
    for (const mood of MOODS) {
      const tone = speechToneFor(mood);
      expect(tone.rate).toBeGreaterThanOrEqual(0.9);
      expect(tone.rate).toBeLessThanOrEqual(1.15);
      expect(tone.pitch).toBeGreaterThanOrEqual(0.95);
      expect(tone.pitch).toBeLessThanOrEqual(1.2);
    }
  });

  it("方向要对得上：担心比开心慢，开心比担心高", () => {
    expect(speechToneFor("concerned").rate).toBeLessThan(speechToneFor("happy").rate);
    expect(speechToneFor("happy").pitch).toBeGreaterThan(speechToneFor("concerned").pitch);
  });

  it("没有语气时退回 neutral 的取值", () => {
    expect(speechToneFor(undefined)).toEqual(speechToneFor("neutral"));
  });
});

describe("MOOD_RULES", () => {
  it("每个语气都写清楚什么时候用——只列七个英文单词她会往 happy 上偏", () => {
    for (const mood of MOODS) expect(MOOD_RULES).toContain(`- ${mood}：`);
  });

  it("写明标的是她自己的状态，不是对方的心情", () => {
    expect(MOOD_RULES).toContain("不是对方的心情");
  });
});
