import { describe, expect, it } from "vitest";
import type { MemoryCandidate, MemoryRecordV2 } from "../../domain/memory";
import { createInMemoryMemoryStore } from "./memoryStore";
import { createMemoryRepository, type MemoryRepository } from "./memoryRepository";
import {
  createMemoryMaintenance,
  type MaintenanceJournalState,
} from "./writeback";

const NOW = 1_788_998_400_000;

function candidate(content: string, category: MemoryCandidate["category"] = "偏好"): MemoryCandidate {
  return { content, category };
}

function setup(overrides: Partial<Parameters<typeof createMemoryMaintenance>[0]> = {}) {
  const store = createInMemoryMemoryStore();
  const repo = createMemoryRepository({ store, clock: () => NOW });
  const errors: string[] = [];
  const savedStates: MaintenanceJournalState[] = [];
  const journal = {
    load: async () => savedStates.length ? savedStates[savedStates.length - 1]! : null,
    save: async (state: MaintenanceJournalState) => {
      savedStates.push(state);
    },
  };
  const maintenance = createMemoryMaintenance({
    repository: repo,
    journal,
    maxAttempts: 3,
    onError: (error) => {
      errors.push(error instanceof Error ? error.message : String(error));
    },
    ...overrides,
  });
  return { store, repo, maintenance, errors, savedStates, journal };
}

/** 手工构造一条日志状态：模拟上个进程崩溃时批次的落盘样子。 */
function journalState(batches: MaintenanceJournalState["batches"], epoch = 0): MaintenanceJournalState {
  return { epoch, batches };
}

function flushMicrotasks(times = 6): Promise<void> {
  let chain = Promise.resolve();
  for (let index = 0; index < times; index += 1) chain = chain.then(() => undefined);
  return chain;
}

describe("后台维护队列：写入语义（沿用写回契约）", () => {
  it("把抽取候选写成候选记忆，来源挂在消息 id 上", async () => {
    const { store, maintenance } = setup();
    maintenance.enqueue({ turnId: "t-1", sourceMessageIds: ["msg-1"], candidates: [candidate("喝咖啡只喝浅烘焙")] });

    const result = await maintenance.flush("sessionEnd");
    expect(result).toMatchObject({ attempted: 1, written: 1, failed: 0 });
    expect(store.current().records[0]).toMatchObject({
      content: "喝咖啡只喝浅烘焙",
      type: "preference",
      status: "candidate",
      sourceMessageIds: ["msg-1"],
      sourceKind: "messages",
    });
  });

  it("落库失败时留在队列里按退避重试；显式 flush 重置连败计数", async () => {
    const { store, maintenance } = setup();
    store.failNextSave = true;
    maintenance.enqueue({ turnId: "t-2", sourceMessageIds: ["msg-2"], candidates: [candidate("喜欢爵士乐")] });

    const first = await maintenance.flush("sessionEnd");
    expect(first.written).toBe(0);
    expect(maintenance.pending()).toBe(1);

    const second = await maintenance.flush("sessionEnd");
    expect(second).toMatchObject({ attempted: 1, written: 1, failed: 0 });
    expect(maintenance.pending()).toBe(0);
    expect(store.current().records).toHaveLength(1);
  });

  it("连续失败到上限标 failed 并可见报错，不再无限重试", async () => {
    const { store, maintenance, errors } = setup();
    maintenance.enqueue({ turnId: "t-3", sourceMessageIds: ["msg-3"], candidates: [candidate("想去冰岛")] });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      store.failNextSave = true;
      await maintenance.flush("sessionEnd");
    }

    expect(maintenance.pending()).toBe(1);
    expect(maintenance.snapshot()[0]).toMatchObject({ status: "failed", attempts: 3 });
    expect(errors).toContain("存储写入失败（注入）");
    expect(store.current().records).toEqual([]);
  });

  it("重放已删除的来源不会让记忆复活（抑制标记优先）", async () => {
    const { repo, maintenance } = setup();
    maintenance.enqueue({ turnId: "t-4", sourceMessageIds: ["msg-4"], candidates: [candidate("咖啡只喝浅烘焙")] });
    await maintenance.flush("sessionEnd");
    const [written] = await repo.list();
    expect(await repo.forget(written.id)).toBe(true);

    // 同一批候选再跑一遍（模型重放、重试到的旧任务）。
    maintenance.enqueue({ turnId: "t-4", sourceMessageIds: ["msg-4"], candidates: [candidate("咖啡只喝浅烘焙")] });
    await maintenance.flush("sessionEnd");
    expect(await repo.list()).toEqual([]);
  });

  it("空候选与畸形候选都不进队列、不产记录", async () => {
    const { store, maintenance } = setup();
    maintenance.enqueue({ turnId: "t-5", sourceMessageIds: ["msg-5"], candidates: [] });
    maintenance.enqueue({ turnId: "t-5", sourceMessageIds: ["msg-5"], candidates: [candidate("   ")] });
    expect(maintenance.pending()).toBe(0);

    const result = await maintenance.flush("sessionEnd");
    expect(result.attempted).toBe(0);
    expect(store.current().records).toEqual([]);
  });
});

describe("后台维护队列：LLM-04 触发与幂等", () => {
  it("noteTurn 按阈值触发后台批，且不阻塞调用方", async () => {
    const { store, maintenance } = setup({ turnThreshold: 2 });
    maintenance.enqueue({ turnId: "t-1", sourceMessageIds: ["m-1"], candidates: [candidate("第一条")] });
    maintenance.noteTurn("t-1");
    maintenance.noteTurn("t-2");
    // 阈值触发是 fire-and-forget：给微任务几轮让它跑完。
    await flushMicrotasks();
    expect(store.current().records).toHaveLength(1);
  });

  it("同一来源重复投递不生成第二批；done 后重复投递不再执行", async () => {
    const { store, maintenance } = setup();
    maintenance.enqueue({ turnId: "t-1", sourceMessageIds: ["m-1", "m-2"], candidates: [candidate("只此一批")] });
    await maintenance.flush("sessionEnd");
    expect(store.current().records).toHaveLength(1);

    maintenance.enqueue({ turnId: "t-2", sourceMessageIds: ["m-1", "m-2"], candidates: [candidate("只此一批")] });
    const result = await maintenance.flush("sessionEnd");
    expect(result.attempted).toBe(0);
    expect(store.current().records).toHaveLength(1);
  });

  it("重启恢复：日志里 running 批次回到 pending 并完成写入", async () => {
    const { store, repo } = setup();
    const batchId = "v1-abc";
    const previous: MaintenanceJournalState = journalState([{
      id: batchId,
      sourceTurnIds: ["t-9"],
      sourceMessageIds: ["m-9"],
      candidates: [candidate("上个进程没写完的事")],
      status: "running",
      attempts: 1,
      nextAttemptAt: 0,
    }]);
    const savedStates: MaintenanceJournalState[] = [previous];
    const maintenance = createMemoryMaintenance({
      repository: repo,
      journal: { load: async () => savedStates.length ? savedStates[savedStates.length - 1]! : null, save: async () => undefined },
    });

    await maintenance.restore();
    expect(maintenance.snapshot()[0]).toMatchObject({ id: batchId, status: "pending" });
    await maintenance.flush("sessionEnd");
    expect(store.current().records.map((record) => record.content)).toEqual(["上个进程没写完的事"]);
  });

  it("关闭维护：待处理批次作废，重新开启不复活", async () => {
    const { store, maintenance } = setup();
    maintenance.enqueue({ turnId: "t-1", sourceMessageIds: ["m-1"], candidates: [candidate("不该被写")] });
    maintenance.setEnabled(false);
    await maintenance.flush("sessionEnd");
    expect(store.current().records).toEqual([]);

    maintenance.setEnabled(true);
    await maintenance.flush("sessionEnd");
    expect(store.current().records).toEqual([]);
    expect(maintenance.pending()).toBe(0);
  });

  it("提交边界：等待期间关闭，已提交内容不回滚，但批次不再重跑", async () => {
    const { store, repo } = setup();
    const gateState: { release: (() => void) | null } = { release: null };
    const gate = new Promise<void>((resolve) => {
      gateState.release = resolve;
    });
    const gated: MemoryRepository = {
      ...repo,
      upsert: async (records: readonly MemoryRecordV2[]) => {
        await gate;
        await repo.upsert(records);
      },
    } as MemoryRepository;
    const gatedMaintenance = createMemoryMaintenance({
      repository: gated,
      journal: { load: async () => null, save: async () => undefined },
      maxAttempts: 3,
    });
    gatedMaintenance.enqueue({ turnId: "t-1", sourceMessageIds: ["m-1"], candidates: [candidate("已过提交点")] });

    const run = gatedMaintenance.flush("sessionEnd");
    await flushMicrotasks();
    gatedMaintenance.setEnabled(false);
    gateState.release?.();
    await run;

    // 已提交的内容留在存储里（不回滚），但批次被作废：重开、再 flush 都不会二次写。
    expect(store.current().records.map((record) => record.content)).toEqual(["已过提交点"]);
    gatedMaintenance.setEnabled(true);
    const again = await gatedMaintenance.flush("sessionEnd");
    expect(again.attempted).toBe(0);
    expect(store.current().records).toHaveLength(1);
  });
});

describe("后台维护队列：退避与容量", () => {
  it("自动重试按指数退避（1s→2s），到点前非强制运行不执行", async () => {
    let clockNow = NOW;
    const { store, repo } = setup();
    const scheduled: Array<{ fn: () => void; ms: number }> = [];
    const maintenance = createMemoryMaintenance({
      repository: repo,
      journal: { load: async () => null, save: async () => undefined },
      now: () => clockNow,
      schedule: (fn, ms) => {
        scheduled.push({ fn, ms });
        return () => undefined;
      },
    });
    maintenance.enqueue({ turnId: "t-1", sourceMessageIds: ["m-1"], candidates: [candidate("等退避")] });

    // 第一次失败 → 1s 后重试。
    store.failNextSave = true;
    await maintenance.flush("sessionEnd");
    expect(scheduled[scheduled.length - 1]?.ms).toBe(1_000);
    expect(maintenance.snapshot()[0].nextAttemptAt).toBe(NOW + 1_000);

    // 到点前：非强制运行（调度回调）不执行写入。
    store.failNextSave = false;
    scheduled[scheduled.length - 1]!.fn();
    await flushMicrotasks();
    expect(store.current().records).toHaveLength(0);

    // 第二次失败 → 退避翻倍到 2s；时钟拨过 nextAttemptAt 后调度回调真正写入。
    store.failNextSave = true;
    await maintenance.flush("sessionEnd");
    expect(scheduled[scheduled.length - 1]?.ms).toBe(2_000);
    store.failNextSave = false;
    clockNow = NOW + 2_000;
    scheduled[scheduled.length - 1]!.fn();
    await flushMicrotasks();
    expect(store.current().records.map((record) => record.content)).toEqual(["等退避"]);
  });

  it("待处理批次总量超上限拒收并可见报错", async () => {
    const { maintenance, errors } = setup({ maxPendingBatches: 1 });
    maintenance.enqueue({ turnId: "t-1", sourceMessageIds: ["m-1"], candidates: [candidate("第一批")] });
    maintenance.enqueue({ turnId: "t-2", sourceMessageIds: ["m-2"], candidates: [candidate("第二批")] });
    expect(errors.some((message) => message.includes("队列已满"))).toBe(true);
    expect(maintenance.pending()).toBe(1);
  });

  it("单批候选超上限拆成同源的下一批", async () => {
    const { store, maintenance } = setup({ maxBatchCandidates: 2 });
    maintenance.enqueue({
      turnId: "t-1",
      sourceMessageIds: ["m-1"],
      candidates: [candidate("一"), candidate("二"), candidate("三")],
    });
    expect(maintenance.pending()).toBe(2);
    await maintenance.flush("sessionEnd");
    expect(store.current().records.map((record) => record.content)).toEqual(["一", "二", "三"]);
  });
});
