import { describe, expect, it } from "vitest";
import { createMemoryV2, type MemoryRecordV2 } from "./memory";
import {
  factTimeOf, isEligible, rankMemories, recencyOf, saturate, temporalStatusOf, tokenize,
  type MemoryQuery,
} from "./memoryRetrieval";

const NOW = 1_788_998_400_000;
const DAY = 86_400_000;

function record(overrides: Partial<MemoryRecordV2> & { id: string; content: string }): MemoryRecordV2 {
  return createMemoryV2({
    content: overrides.content,
    now: overrides.createdAt ?? NOW - 7 * DAY,
    id: overrides.id,
    type: overrides.type,
    status: overrides.status,
    importance: overrides.importance,
    validFrom: overrides.validFrom,
    validUntil: overrides.validUntil,
    sourceMessageIds: overrides.sourceMessageIds,
    sourceKind: overrides.sourceKind,
  }) as MemoryRecordV2;
}

function query(text: string, overrides: Partial<MemoryQuery> = {}): MemoryQuery {
  return { text, now: NOW, limit: 5, tokenBudget: 400, ...overrides };
}

describe("tokenize", () => {
  it("中文按单字与相邻二字组切，英文按词切", () => {
    const tokens = tokenize("他喜欢喝咖啡");
    expect(tokens).toContain("咖啡");
    expect(tokens).toContain("喝");
    // 「喜欢」是停用词：它几乎出现在每条偏好里，留着等于没检索。
    expect(tokens).not.toContain("喜欢");
  });

  it("英文与数字小写归一", () => {
    expect(tokenize("Prefers Dark Chocolate")).toEqual(expect.arrayContaining(["prefers", "dark", "chocolate"]));
    expect(tokenize("React 18")).toEqual(expect.arrayContaining(["react", "18"]));
  });

  it("日文假名与汉字都能切出来", () => {
    const tokens = tokenize("塩気のあるお菓子が好き");
    expect(tokens).toContain("塩気");
    expect(tokens).toContain("菓子");
  });
});

describe("评分构成", () => {
  it("相关性饱和在 [0,1) 内", () => {
    expect(saturate(0)).toBe(0);
    expect(saturate(1)).toBeGreaterThan(0);
    expect(saturate(1)).toBeLessThan(1);
    expect(saturate(1000)).toBeLessThan(1);
  });

  it("recency 用事实时间，不用访问时间", () => {
    const fresh = record({ id: "a", content: "刚发生的事", createdAt: NOW - DAY });
    const old = record({ id: "b", content: "很久以前的事", createdAt: NOW - 400 * DAY });
    expect(recencyOf(fresh, NOW)).toBeGreaterThan(recencyOf(old, NOW));

    // 访问时间不参与：被反复读到也不会让旧事变新。
    const accessed = { ...old, lastAccessedAt: NOW };
    expect(factTimeOf(accessed)).toBe(old.createdAt);
    expect(recencyOf(accessed, NOW)).toBeCloseTo(recencyOf(old, NOW), 10);
  });

  it("确认时间优先于创建时间作为事实时间", () => {
    const confirmed = record({ id: "c", content: "后来才确认的事", createdAt: NOW - 300 * DAY });
    expect(factTimeOf({ ...confirmed, lastConfirmedAt: NOW - DAY })).toBe(NOW - DAY);
  });
});

describe("过滤规则", () => {
  it("superseded 一律排除", () => {
    const superseded = record({ id: "s", content: "喜欢拿铁", status: "superseded" });
    expect(isEligible(superseded, NOW)).toBe(false);
    expect(rankMemories([superseded], query("拿铁"))).toEqual([]);
  });

  it("过期的事件保留但标 past，过期的偏好不再算当前事实", () => {
    const pastEvent = record({
      id: "e", content: "去年去了北海道", type: "event",
      validFrom: NOW - 300 * DAY, validUntil: NOW - 5 * DAY,
    });
    const expiredPreference = record({
      id: "p", content: "以前住在涩谷", type: "preference",
      validFrom: NOW - 300 * DAY, validUntil: NOW - 10 * DAY,
    });

    expect(isEligible(pastEvent, NOW)).toBe(true);
    expect(temporalStatusOf(pastEvent, NOW)).toBe("past");
    expect(isEligible(expiredPreference, NOW)).toBe(false);

    const hits = rankMemories([pastEvent, expiredPreference], query("北海道 涩谷"));
    expect(hits.map((hit) => hit.record.id)).toEqual(["e"]);
    expect(hits[0].temporalStatus).toBe("past");
  });

  it("尚未生效的记录不参与检索", () => {
    const future = record({ id: "f", content: "下个月开始学吉他", validFrom: NOW + 30 * DAY });
    expect(isEligible(future, NOW)).toBe(false);
  });

  it("没有共同词时返回空集，不硬塞无关记忆", () => {
    const records = [
      record({ id: "a", content: "养了一只叫豆豆的橘猫" }),
      record({ id: "b", content: "生日是十一月三号" }),
    ];
    expect(rankMemories(records, query("violin"))).toEqual([]);
  });
});

describe("rankMemories", () => {
  it("命中带可解释的理由，且按分数降序", () => {
    const records = [
      record({ id: "a", content: "咖啡只喝浅烘焙", importance: 0.9 }),
      record({ id: "b", content: "咖啡豆存放在冰箱", importance: 0.2 }),
    ];
    const hits = rankMemories(records, query("他喝什么咖啡"));
    expect(hits.length).toBe(2);
    expect(hits[0].score).toBeGreaterThanOrEqual(hits[1].score);
    expect(hits[0].reasons.join(" ")).toContain("相关度");
  });

  it("按 token 预算裁剪，不把上下文撑爆", () => {
    const records = Array.from({ length: 10 }, (_, index) => (
      record({ id: `m${index}`, content: `第${index}条关于咖啡的记忆${"あ".repeat(80)}` })
    ));
    const hits = rankMemories(records, query("咖啡", { limit: 10, tokenBudget: 120 }));
    expect(hits.length).toBeLessThan(10);
    expect(hits.length).toBeGreaterThan(0);
  });

  it("分数构成可复算：0.7 相关 + 0.2 新近 + 0.1 重要度", () => {
    const only = record({ id: "x", content: "唯一的咖啡记忆", importance: 1, createdAt: NOW });
    // 外部源（如 SQLite FTS）给的是未归一的原始分，因此这里要过 saturate。
    const [hit] = rankMemories([only], query("咖啡"), { relevanceOf: () => 1 });
    expect(hit.score).toBeCloseTo(0.7 * saturate(1) + 0.2 * 1 + 0.1 * 1, 10);
  });
});
