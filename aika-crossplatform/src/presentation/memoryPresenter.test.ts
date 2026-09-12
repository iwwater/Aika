import { describe, expect, it } from "vitest";
import type { MemoryRecordV2 } from "../domain/memory";
import { createMemoryRepository, type MemoryRepository } from "../services/memory/memoryRepository";
import { createInMemoryMemoryStore } from "../services/memory/memoryStore";
import type { MemoryAccess } from "../services/memory/tokens";
import { createMemoryPresenter } from "./memoryPresenter";

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

function record(id: string, patch: Partial<MemoryRecordV2> = {}): MemoryRecordV2 {
  return {
    schemaVersion: 2,
    id,
    type: "fact",
    content: `记忆 ${id}`,
    sourceMessageIds: [`m-${id}`],
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

/**
 * 真仓储 + 内存存储（生产代码路径），外面套一层与 `memoryPlugin` 同形状的 access：
 * 删除经 onInvalidate 扇出到 changed 订阅者，确认/编辑靠调用方喊 notifyChanged。
 */
function setup(records: MemoryRecordV2[], patchRepository?: (base: MemoryRepository) => MemoryRepository) {
  const store = createInMemoryMemoryStore({
    initial: { schemaVersion: 2, records, suppressions: [], migrationVersion: 1 },
  });
  const invalidated: string[] = [];
  const changedListeners = new Set<() => void>();
  const fanOut = () => {
    for (const listener of [...changedListeners]) listener();
  };

  const base = createMemoryRepository({
    store,
    clock: () => NOW,
    onInvalidate: (event) => {
      invalidated.push(event.recordId);
      fanOut();
    },
  });
  let changedCount = 0;
  const access: MemoryAccess = {
    repository: patchRepository ? patchRepository(base) : base,
    onInvalidate: () => () => undefined,
    onChanged(listener) {
      changedListeners.add(listener);
      return () => {
        changedListeners.delete(listener);
      };
    },
    notifyChanged() {
      changedCount += 1;
      fanOut();
    },
  };

  const presenter = createMemoryPresenter({ access, clock: () => NOW });
  return {
    presenter,
    store,
    invalidated,
    fanOut,
    changed: () => changedCount,
    current: () => store.current().records,
    find: (id: string) => store.current().records.find((item) => item.id === id) ?? null,
  };
}

describe("createMemoryPresenter", () => {
  it("没有记忆能力时 available 为 false，不给一份假空列表", async () => {
    const presenter = createMemoryPresenter({ access: null, clock: () => NOW });
    await presenter.start();

    expect(presenter.getSnapshot()).toMatchObject({ available: false, rows: [], total: 0 });
  });

  it("装载后按 V2 原貌列出，待过目的计数单独给（FE-11-A/C）", async () => {
    const { presenter } = setup([
      record("a"),
      record("b", { status: "candidate" }),
      record("c", { status: "superseded" }),
    ]);
    await presenter.start();
    const view = presenter.getSnapshot();

    // superseded 默认不列，但 total 仍然算它：库里确实有三条。
    expect(view.rows.map((row) => row.record.id)).toEqual(["b", "a"]);
    expect(view.total).toBe(3);
    expect(view.pendingCount).toBe(1);
    expect(view.empty).toBeNull();
  });

  it("筛选变了，勾选自动摘掉看不见的那些（FE-11-B/D）", async () => {
    const { presenter } = setup([record("a", { type: "goal" }), record("b", { type: "preference" })]);
    await presenter.start();

    presenter.toggleSelect("a");
    presenter.toggleSelect("b");
    expect([...presenter.getSnapshot().selected].sort()).toEqual(["a", "b"]);

    presenter.setFilter({ type: "goal" });
    // 看不见的 b 不该还留在批量操作里——否则一按删除就删掉了没在看的东西。
    expect(presenter.getSnapshot().selected).toEqual(["a"]);
  });

  it("筛没了与一条都没有是两种空状态（FE-11-B）", async () => {
    const { presenter } = setup([record("a", { content: "喜欢咖啡" })]);
    await presenter.start();

    presenter.setFilter({ text: "不存在的词" });
    expect(presenter.getSnapshot().empty).toBe("filtered");

    const blank = setup([]);
    await blank.presenter.start();
    expect(blank.presenter.getSnapshot().empty).toBe("none");
  });

  it("确认一条：写 confirmed 与确认时间，并通知别的界面（FE-11-C/F）", async () => {
    const { presenter, find, changed } = setup([record("a", { status: "candidate" })]);
    await presenter.start();

    await presenter.confirm("a");

    expect(find("a")).toMatchObject({ status: "confirmed", lastConfirmedAt: NOW, createdAt: NOW - DAY });
    expect(presenter.getSnapshot().pendingCount).toBe(0);
    expect(presenter.getSnapshot().notice).toBe("已确认 1 条");
    expect(changed()).toBe(1);
  });

  it("编辑：正文改过即 userEdit + confirmed（FE-11-E）", async () => {
    const { presenter, find } = setup([record("a", { content: "喜欢拿铁", status: "candidate" })]);
    await presenter.start();

    presenter.beginEdit("a");
    expect(presenter.getSnapshot().draft).toEqual({ content: "喜欢拿铁", type: "fact" });

    presenter.changeDraft({ content: "只喝浅烘焙", type: "preference" });
    await presenter.saveEdit();

    expect(find("a")).toMatchObject({
      content: "只喝浅烘焙", type: "preference", sourceKind: "userEdit",
      status: "confirmed", createdAt: NOW - DAY,
    });
    expect(presenter.getSnapshot().editingId).toBeNull();
    expect(presenter.getSnapshot().notice).toBe("已保存");
  });

  it("空正文不写盘，并说清楚该走删除（FE-11-E）", async () => {
    const { presenter, store, find } = setup([record("a", { content: "喜欢拿铁" })]);
    await presenter.start();
    const before = store.saveCount;

    presenter.beginEdit("a");
    presenter.changeDraft({ content: "   " });
    await presenter.saveEdit();

    expect(store.saveCount).toBe(before);
    expect(find("a")?.content).toBe("喜欢拿铁");
    expect(presenter.getSnapshot().error).toContain("不能为空");
    // 编辑态留着，用户可以接着改而不是从头再来。
    expect(presenter.getSnapshot().editingId).toBe("a");
  });

  it("删除：落抑制标记并触发摘要作废（FE-11-F）", async () => {
    const { presenter, store, invalidated } = setup([record("a")]);
    await presenter.start();

    await presenter.remove("a");

    expect(store.current().records).toEqual([]);
    expect(store.current().suppressions.map((item) => item.id)).toEqual(["a"]);
    expect(invalidated).toEqual(["a"]);
    expect(presenter.getSnapshot().notice).toBe("已删除 1 条");
  });

  it("批量确认：勾选的全部写 confirmed（FE-11-D）", async () => {
    const { presenter, find } = setup([
      record("a", { status: "candidate" }),
      record("b", { status: "candidate" }),
    ]);
    await presenter.start();

    presenter.selectAllVisible();
    await presenter.confirmSelected();

    expect(find("a")?.status).toBe("confirmed");
    expect(find("b")?.status).toBe("confirmed");
    expect(presenter.getSnapshot().notice).toBe("确认了 2 条");
    expect(presenter.getSnapshot().selected).toEqual([]);
  });

  it("批量删除部分失败：如实报告成功与失败，成功的不回滚（FE-11-D）", async () => {
    const { presenter, current } = setup(
      [record("a"), record("bad"), record("c")],
      (base) => ({
        ...base,
        async forget(id: string) {
          if (id === "bad") throw new Error("写入失败");
          return base.forget(id);
        },
      }),
    );
    await presenter.start();

    presenter.selectAllVisible();
    await presenter.deleteSelected();

    const view = presenter.getSnapshot();
    // 批量不是事务：删了 2 条、1 条失败，必须说出来而不是显示成全成功。
    expect(view.notice).toBe("删除了 2 条，1 条失败：写入失败");
    expect(current().map((item) => item.id)).toEqual(["bad"]);
    // 失败的那条仍勾着，可以直接重试；成功的已经摘掉。
    expect(view.selected).toEqual(["bad"]);
  });

  it("别人改了记忆（对话里抽出新的）会自动重读（FE-11-F）", async () => {
    const { presenter, store, fanOut } = setup([record("a")]);
    await presenter.start();
    expect(presenter.getSnapshot().total).toBe(1);

    // 模拟另一个消费者（companionPresenter 的抽取）写入后喊了一声。
    await store.save({
      ...store.current(),
      records: [...store.current().records, record("b", { status: "candidate" })],
    });
    fanOut();
    await Promise.resolve();
    await Promise.resolve();

    expect(presenter.getSnapshot().total).toBe(2);
    expect(presenter.getSnapshot().pendingCount).toBe(1);
  });

  it("读取失败时留住错误，不把列表清空", async () => {
    const { presenter } = setup([record("a")], (base) => ({
      ...base,
      async list() {
        throw new Error("库读不出来");
      },
    }));
    await presenter.start();

    expect(presenter.getSnapshot().error).toBe("库读不出来");
    expect(presenter.getSnapshot().available).toBe(true);
  });

  it("dispose 之后不再订阅变更", async () => {
    const { presenter, store, fanOut } = setup([record("a")]);
    await presenter.start();
    presenter.dispose();

    await store.save({ ...store.current(), records: [record("a"), record("b")] });
    fanOut();
    await Promise.resolve();

    expect(presenter.getSnapshot().total).toBe(1);
  });
});
