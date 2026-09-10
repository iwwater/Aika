import { describe, expect, it } from "vitest";
import { EMPTY_USER_SOUL, type UserSoul } from "./soul";
import {
  applySoulCorrection, applySoulEvidence, confirmedUserSoul, describeUserSoul, dropSoulSources,
  soulEntryStatus,
} from "./userSoul";

const NOW = 1_788_998_400_000;

describe("LLM-03-C · 画像沉淀", () => {
  it("单条候选不足以覆盖画像", () => {
    const first = applySoulEvidence(EMPTY_USER_SOUL, {
      field: "preferences", value: "喜欢咖啡", sourceMessageIds: ["msg-1"], now: NOW,
    });

    expect(first.changed).toBe(true);
    expect(first.status).toBe("candidate");
    expect(first.soul.preferences).toHaveLength(1);
    expect(confirmedUserSoul(first.soul).preferences).toEqual([]);
    expect(describeUserSoul(first.soul)).toEqual([]);
  });

  it("同一来源重复出现不算第二份证据", () => {
    const once = applySoulEvidence(EMPTY_USER_SOUL, {
      field: "preferences", value: "喜欢咖啡", sourceMessageIds: ["msg-1"], now: NOW,
    });
    const replay = applySoulEvidence(once.soul, {
      field: "preferences", value: "喜欢咖啡", sourceMessageIds: ["msg-1"], now: NOW,
    });

    expect(replay.changed).toBe(false);
    expect(replay.status).toBe("candidate");
    expect(replay.reason).toContain("来源重复");
    expect(replay.soul.preferences[0].sources).toHaveLength(1);
  });

  it("两个不同来源的相容证据才算沉淀", () => {
    const once = applySoulEvidence(EMPTY_USER_SOUL, {
      field: "preferences", value: "喜欢咖啡", sourceMessageIds: ["msg-1"], now: NOW,
    });
    const twice = applySoulEvidence(once.soul, {
      field: "preferences", value: "喜欢咖啡", sourceMessageIds: ["msg-2"], now: NOW,
    });

    expect(twice.changed).toBe(true);
    expect(twice.status).toBe("confirmed");
    expect(soulEntryStatus(twice.soul.preferences[0])).toBe("confirmed");
    expect(describeUserSoul(twice.soul)).toEqual(["preferences: 喜欢咖啡"]);
  });

  it("用户亲手写的直接确认，不需要第二份证据", () => {
    const result = applySoulEvidence(EMPTY_USER_SOUL, {
      field: "goals", value: "明年考 N1", sourceMessageIds: [], sourceKind: "userEdit", now: NOW,
    });
    expect(result.status).toBe("confirmed");
    expect(result.soul.goals[0].sources.some((source) => source.kind === "user")).toBe(true);
  });

  it("置信度高低不改变候选身份", () => {
    const result = applySoulEvidence(EMPTY_USER_SOUL, {
      field: "stableFacts", value: "住在横滨", sourceMessageIds: ["msg-9"], now: NOW,
    });
    // applySoulEvidence 不看置信度：只有来源数量与来源类型决定确认与否。
    expect(result.status).toBe("candidate");
  });
});

describe("用户纠正与删除联动", () => {
  it("用户纠正直接生效，且保留原来源", () => {
    const base: UserSoul = {
      ...EMPTY_USER_SOUL,
      preferences: [
        { value: "喜欢拿铁", sources: [{ kind: "message", reference: "msg-1", capturedAt: NOW }] },
      ],
    };
    const corrected = applySoulCorrection(base, { field: "preferences", from: "喜欢拿铁", to: "不喝拿铁了", now: NOW });

    expect(corrected.changed).toBe(true);
    expect(corrected.soul.preferences.map((entry) => entry.value)).toEqual(["不喝拿铁了"]);
    const entry = corrected.soul.preferences[0];
    expect(soulEntryStatus(entry)).toBe("confirmed");
    expect(entry.sources.map((source) => source.kind).sort()).toEqual(["message", "user"]);
    expect(entry.sources.some((source) => source.reference === "msg-1")).toBe(true);
  });

  it("删除记忆后引用它的画像条目一并失效", () => {
    const base: UserSoul = {
      ...EMPTY_USER_SOUL,
      preferences: [
        { value: "喜欢咖啡", sources: [{ kind: "message", reference: "msg-1" }, { kind: "message", reference: "msg-2" }] },
      ],
      goals: [
        { value: "换工作", sources: [{ kind: "message", reference: "msg-3" }] },
      ],
    };

    const partial = dropSoulSources(base, ["msg-1"]);
    expect(partial.removed).toBe(0);
    expect(partial.soul.preferences[0].sources.map((source) => source.reference)).toEqual(["msg-2"]);
    // 只剩一份来源，自动降回候选。
    expect(soulEntryStatus(partial.soul.preferences[0])).toBe("candidate");

    const all = dropSoulSources(base, ["msg-1", "msg-2", "msg-3"]);
    expect(all.soul.preferences).toEqual([]);
    expect(all.soul.goals).toEqual([]);
    expect(all.removed).toBe(2);
  });

  it("没有引用的删除不改变画像", () => {
    const base: UserSoul = {
      ...EMPTY_USER_SOUL,
      habits: [{ value: "睡前读书", sources: [{ kind: "message", reference: "msg-7" }] }],
    };
    const result = dropSoulSources(base, ["unknown-msg"]);
    expect(result.changed).toBe(false);
    expect(result.soul.habits).toHaveLength(1);
  });
});
