import { describe, expect, it } from "vitest";
import {
  DEFAULT_CHARACTER_SOUL,
  DEFAULT_MODE_CONFIG,
  DEFAULT_SCENARIO,
  EMPTY_USER_SOUL,
  exitScenarioMode,
  modePolicyText,
  normalizeModeConfig,
  type UserSoul,
} from "./soul";

describe("LLM-01 Soul 与 Mode", () => {
  it("三种模式共享同一个 CharacterSoul 身份与稳定边界", () => {
    const modes = ["companion", "oral_practice", "scenario_practice"] as const;
    const souls = modes.map(() => DEFAULT_CHARACTER_SOUL);
    expect(new Set(souls.map((soul) => soul.id)).size).toBe(1);
    expect(new Set(souls.map((soul) => soul.systemPrompt)).size).toBe(1);
    expect(DEFAULT_CHARACTER_SOUL.boundaries.join(" ")).toContain("临时身份");
  });

  it("旧配置或坏配置安全退回 companion", () => {
    expect(normalizeModeConfig(null)).toEqual(DEFAULT_MODE_CONFIG);
    expect(normalizeModeConfig({ mode: "not-a-mode" })).toEqual(DEFAULT_MODE_CONFIG);
    expect(normalizeModeConfig({ mode: "oral_practice", targetLanguage: "xx" }).targetLanguage).toBe("ja-JP");
  });

  it("场景配置可规范化，退出后清掉临时身份", () => {
    const scenario = normalizeModeConfig({
      mode: "scenario_practice",
      scenario: { scenarioId: "interview", title: "面试", setting: "会议室" },
    });
    expect(scenario.mode).toBe("scenario_practice");
    expect(scenario.scenario?.scenarioId).toBe("interview");
    expect(scenario.scenario?.temporaryIdentity).toBe(DEFAULT_SCENARIO.temporaryIdentity);
    const exited = exitScenarioMode(scenario);
    expect(exited.mode).toBe("companion");
    expect(exited.scenario).toBeUndefined();
    expect(modePolicyText(exited)).not.toContain("临时身份：");
  });

  it("UserSoul 保留可追溯来源，LLM-01 不自动填充", () => {
    const soul: UserSoul = {
      ...EMPTY_USER_SOUL,
      preferences: [{ value: "喜欢咖啡", sources: [{ kind: "user", reference: "settings" }] }],
    };
    expect(soul.preferences[0].sources[0].kind).toBe("user");
    expect(EMPTY_USER_SOUL.stableFacts).toHaveLength(0);
  });
});
