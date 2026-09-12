import { describe, expect, it } from "vitest";
import type { MemoryRecordV2 } from "./memory";
import {
  applyMemoryEdit, batchSummary, confirmMemoryRecord, DEFAULT_MEMORY_FILTER,
  emptyKind, filterMemories, MEMORY_STATUS_LABELS, MEMORY_SOURCE_LABELS, toMemoryRow,
} from "./memoryAdmin";

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

function record(id: string, patch: Partial<MemoryRecordV2> = {}): MemoryRecordV2 {
  return {
    schemaVersion: 2,
    id,
    type: "fact",
    content: `记忆 ${id}`,
    sourceMessageIds: ["m1"],
    sourceKind: "messages",
    status: "confirmed",
    confidence: 0.8,
    importance: 0.5,
    createdAt: NOW - DAY,
    updatedAt: NOW - DAY,
    lastConfirmedAt: null,
    lastAccessedAt: null,
    validFrom: null,
    validUntil: null,
    ...patch,
  };
}

function ids(rows: readonly { record: MemoryRecordV2 }[]): string[] {
  return rows.map((row) => row.record.id);
}

describe("filterMemories", () => {
  it("按 V2 原貌给出，不走 V1 降级（FE-11-A）", () => {
    const rows = filterMemories([record("a", { type: "preference", status: "candidate" })], DEFAULT_MEMORY_FILTER, NOW);

    expect(rows[0]).toMatchObject({
      typeLabel: "偏好",
      statusLabel: "待过目",
      confidencePercent: 80,
      needsReview: true,
    });
    // V1 只有「日常/偏好/计划/人际/情绪」与 pending/confirmed，这两项在这里必须是 V2 的原值。
    expect(rows[0].record.type).toBe("preference");
    expect(rows[0].record.status).toBe("candidate");
  });

  it("被取代的默认不列，可切换显示并标明取代了谁（FE-11-A）", () => {
    const old = record("old", { content: "喜欢拿铁" });
    const next = record("new", { content: "只喝浅烘焙", supersedesId: "old" });
    const records = [{ ...old, status: "superseded" as const }, next];

    expect(ids(filterMemories(records, DEFAULT_MEMORY_FILTER, NOW))).toEqual(["new"]);

    const all = filterMemories(records, { ...DEFAULT_MEMORY_FILTER, includeSuperseded: true }, NOW);
    expect(ids(all).sort()).toEqual(["new", "old"]);
    expect(all.find((row) => row.record.id === "new")?.supersedesContent).toBe("喜欢拿铁");
    expect(all.find((row) => row.record.id === "old")?.statusLabel).toBe("已被取代");
  });

  it("按类型与状态筛（FE-11-B）", () => {
    const records = [
      record("a", { type: "goal" }),
      record("b", { type: "preference" }),
      record("c", { type: "goal", status: "candidate" }),
    ];

    expect(ids(filterMemories(records, { ...DEFAULT_MEMORY_FILTER, type: "goal" }, NOW)).sort())
      .toEqual(["a", "c"]);
    expect(ids(filterMemories(records, { ...DEFAULT_MEMORY_FILTER, status: "candidate" }, NOW)))
      .toEqual(["c"]);
  });

  it("搜索归一大小写与空白（FE-11-B）", () => {
    const records = [
      record("a", { content: "喜欢 Dark Chocolate" }),
      record("b", { content: "每天 7 点起床" }),
    ];

    expect(ids(filterMemories(records, { ...DEFAULT_MEMORY_FILTER, text: "dark chocolate" }, NOW)))
      .toEqual(["a"]);
    expect(ids(filterMemories(records, { ...DEFAULT_MEMORY_FILTER, text: "  7点  " }, NOW)))
      .toEqual(["b"]);
    expect(filterMemories(records, { ...DEFAULT_MEMORY_FILTER, text: "咖啡" }, NOW)).toEqual([]);
  });

  it("待过目的置顶，其余按更新时间倒序（FE-11-C）", () => {
    const records = [
      record("old", { updatedAt: NOW - 3 * DAY }),
      record("fresh", { updatedAt: NOW - DAY }),
      record("todo", { status: "candidate", updatedAt: NOW - 10 * DAY }),
    ];

    // 待过目的即使最旧也在最前：审核流的入口就是这一屏。
    expect(ids(filterMemories(records, DEFAULT_MEMORY_FILTER, NOW))).toEqual(["todo", "fresh", "old"]);
  });

  it("时间相同也稳定排序，刷新不跳来跳去", () => {
    const records = [record("b", { updatedAt: NOW }), record("a", { updatedAt: NOW })];

    expect(ids(filterMemories(records, DEFAULT_MEMORY_FILTER, NOW))).toEqual(["a", "b"]);
  });
});

describe("emptyKind", () => {
  it("「筛没了」与「一条都没有」是两种空（FE-11-B）", () => {
    expect(emptyKind(0, 0)).toBe("none");
    expect(emptyKind(7, 0)).toBe("filtered");
    expect(emptyKind(7, 3)).toBeNull();
  });
});

describe("toMemoryRow 的来源标注", () => {
  it("不伪造来源：迁移来的就说来源不明（FE-11-G）", () => {
    const legacy = record("a", { sourceKind: "legacy", sourceMessageIds: [] });

    expect(toMemoryRow(legacy, [legacy], NOW).sourceLabel).toBe("来源不明（迁移自旧版）");
    expect(MEMORY_SOURCE_LABELS.legacy).toBe("来源不明（迁移自旧版）");
  });

  it("对话来源带条数；来源没留下时直说（FE-11-G）", () => {
    const withSources = record("a", { sourceMessageIds: ["m1", "m2"] });
    const without = record("b", { sourceMessageIds: [] });

    expect(toMemoryRow(withSources, [withSources], NOW).sourceLabel).toBe("来自对话 · 2 条来源消息");
    expect(toMemoryRow(without, [without], NOW).sourceLabel).toBe("来自对话 · 来源没留下");
  });

  it("用户手写的标成「你写的」（FE-11-G）", () => {
    const mine = record("a", { sourceKind: "userEdit" });

    expect(toMemoryRow(mine, [mine], NOW).sourceLabel).toBe("你写的");
  });

  it("置信度未知是 null，不画成 0", () => {
    const unknown = record("a", { confidence: null });

    // 「不知道有多可信」和「可信度为零」是相反的结论。
    expect(toMemoryRow(unknown, [unknown], NOW).confidencePercent).toBeNull();
    expect(toMemoryRow(record("b", { confidence: 0 }), [], NOW).confidencePercent).toBe(0);
  });

  it("有效期：过期、尚未生效、有时限、无时限四种", () => {
    const note = (patch: Partial<MemoryRecordV2>) => toMemoryRow(record("a", patch), [], NOW).validityNote;

    expect(note({ validUntil: NOW - DAY })).toBe("已过期");
    expect(note({ validFrom: NOW + DAY })).toBe("尚未生效");
    expect(note({ validUntil: NOW + DAY })).toBe("有时限");
    expect(note({})).toBeNull();
  });

  it("每种状态都有中文标签", () => {
    expect(Object.values(MEMORY_STATUS_LABELS)).toEqual(["待过目", "已确认", "已被取代"]);
  });
});

describe("applyMemoryEdit", () => {
  it("改了正文就标 userEdit 并确认（FE-11-E）", () => {
    const before = record("a", { content: "喜欢拿铁", status: "candidate", createdAt: NOW - 5 * DAY });
    const after = applyMemoryEdit(before, { content: "只喝浅烘焙", type: "preference" }, NOW);

    expect(after).toMatchObject({
      content: "只喝浅烘焙",
      type: "preference",
      // userEdit 这个标记不能省：仓储的抑制规则对它网开一面，删掉之后还能重新记住。
      sourceKind: "userEdit",
      status: "confirmed",
      lastConfirmedAt: NOW,
      updatedAt: NOW,
    });
    // 创建时间不因为改了个错字而改变。
    expect(after?.createdAt).toBe(NOW - 5 * DAY);
    expect(after?.id).toBe("a");
  });

  it("只改类型不算改正文，来源保持原样（FE-11-E）", () => {
    const before = record("a", { content: "每天 7 点起床", sourceKind: "messages" });
    const after = applyMemoryEdit(before, { content: "每天 7 点起床", type: "event" }, NOW);

    expect(after).toMatchObject({ type: "event", sourceKind: "messages", status: "confirmed" });
  });

  it("正文只差空白也不算改（口径与仓储去重一致）", () => {
    const before = record("a", { content: "喜欢咖啡", sourceKind: "messages" });

    expect(applyMemoryEdit(before, { content: " 喜欢咖啡 ", type: "fact" }, NOW)?.sourceKind).toBe("messages");
  });

  it("空正文拒绝，不产生记录（FE-11-E）", () => {
    expect(applyMemoryEdit(record("a"), { content: "   ", type: "fact" }, NOW)).toBeNull();
  });
});

describe("confirmMemoryRecord", () => {
  it("只改状态与确认时间（FE-11-C）", () => {
    const before = record("a", { status: "candidate", content: "原话", sourceKind: "messages", createdAt: NOW - DAY });
    const after = confirmMemoryRecord(before, NOW);

    expect(after).toMatchObject({
      status: "confirmed", lastConfirmedAt: NOW, updatedAt: NOW,
      content: "原话", sourceKind: "messages", createdAt: NOW - DAY,
    });
  });
});

describe("batchSummary", () => {
  it("部分失败要说出来，不谎报全成功（FE-11-D）", () => {
    expect(batchSummary("删除", { ok: 3, failed: 0, errors: [] })).toBe("删除了 3 条");
    expect(batchSummary("删除", { ok: 3, failed: 2, errors: [{ id: "x", message: "写入失败" }] }))
      .toBe("删除了 3 条，2 条失败：写入失败");
    expect(batchSummary("确认", { ok: 0, failed: 2, errors: [{ id: "x", message: "写入失败" }] }))
      .toBe("2 条都没能确认：写入失败");
  });

  it("没有原因也不编一个", () => {
    expect(batchSummary("删除", { ok: 0, failed: 1, errors: [] })).toBe("1 条都没能删除：未知原因");
  });
});
