import { describe, expect, it } from "vitest";
import {
  mayElevateToConfirmed, mayFeedUserSoul, sourceKindForOrigin,
} from "./memory";

describe("来源信任分级（RT-04-A/B）", () => {
  it("本地桌面自述 → messages（可信来源，仍需人工确认才能 confirmed）", () => {
    expect(sourceKindForOrigin("desktop", { bound: true })).toBe("messages");
  });

  it("已绑定外部主体的 DM → external-bound：只认证发件人，不证明是本人事实", () => {
    expect(sourceKindForOrigin("telegram", { bound: true })).toBe("external-bound");
    expect(sourceKindForOrigin("feishu", { bound: true })).toBe("external-bound");
  });

  it("未绑定的外部来源 → untrusted-material：外部声明 userId 无效", () => {
    expect(sourceKindForOrigin("telegram", { bound: false })).toBe("untrusted-material");
    expect(sourceKindForOrigin("unknown", { bound: false })).toBe("untrusted-material");
  });

  it("群聊/Agent 输出/引文材料一律 untrusted-material，即使来自本地（RT-04-A）", () => {
    expect(sourceKindForOrigin("desktop", { bound: true, isGroupConversation: true })).toBe("untrusted-material");
    expect(sourceKindForOrigin("desktop", { bound: true, isAgentOutput: true })).toBe("untrusted-material");
    expect(sourceKindForOrigin("telegram", { bound: true, isQuotedMaterial: true })).toBe("untrusted-material");
  });

  it("proactive/environment 产出不是用户自述", () => {
    expect(sourceKindForOrigin("environment", { bound: true })).toBe("untrusted-material");
  });
});

describe("提升与画像门（RT-04-A/B/D）", () => {
  it("模型生成的候选永不自行提升为 confirmed", () => {
    expect(mayElevateToConfirmed(true)).toBe(false);
    // 人工路径（userEdit / 管理页确认）可以提升。
    expect(mayElevateToConfirmed(false)).toBe(true);
  });

  it("User Soul 只接受明确归属且经人确认的内容", () => {
    // 本地对话候选未确认：不行。
    expect(mayFeedUserSoul("messages", "candidate")).toBe(false);
    // 本地对话且已确认：可以。
    expect(mayFeedUserSoul("messages", "confirmed")).toBe(true);
    expect(mayFeedUserSoul("legacy", "confirmed")).toBe(true);
    expect(mayFeedUserSoul("userEdit", "confirmed")).toBe(true);
    // 外部绑定与不可信材料：即使被人确认也不归入本地用户画像。
    expect(mayFeedUserSoul("external-bound", "confirmed")).toBe(false);
    expect(mayFeedUserSoul("untrusted-material", "confirmed")).toBe(false);
    expect(mayFeedUserSoul("untrusted-material", "candidate")).toBe(false);
  });
});
