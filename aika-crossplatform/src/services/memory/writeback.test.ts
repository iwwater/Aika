import { describe, expect, it } from "vitest";
import type { MemoryCandidate } from "../../domain/memory";
import { createInMemoryMemoryStore } from "./memoryStore";
import { createMemoryRepository } from "./memoryRepository";
import { createMemoryWriteback } from "./writeback";

const NOW = 1_788_998_400_000;

function candidate(content: string, category: MemoryCandidate["category"] = "偏好"): MemoryCandidate {
  return { content, category };
}

function setup() {
  const store = createInMemoryMemoryStore();
  const repo = createMemoryRepository({ store, clock: () => NOW });
  const errors: string[] = [];
  const writeback = createMemoryWriteback({
    repository: repo,
    maxAttempts: 3,
    onError: (error) => {
      errors.push(error instanceof Error ? error.message : String(error));
    },
  });
  return { store, repo, writeback, errors };
}

describe("后台写回", () => {
  it("把抽取候选写成候选记忆，来源挂在消息 id 上", async () => {
    const { store, writeback } = setup();
    writeback.enqueue({ candidates: [candidate("喝咖啡只喝浅烘焙")], sourceMessageIds: ["msg-1"], now: NOW });

    const result = await writeback.flush();
    expect(result).toMatchObject({ attempted: 1, written: 1, failed: 0 });
    expect(store.current().records[0]).toMatchObject({
      content: "喝咖啡只喝浅烘焙",
      type: "preference",
      status: "candidate",
      sourceMessageIds: ["msg-1"],
      sourceKind: "messages",
    });
  });

  it("落库失败时留在队列里，下一次 flush 重试成功", async () => {
    const { store, writeback, errors } = setup();
    store.failNextSave = true;
    writeback.enqueue({ candidates: [candidate("喜欢爵士乐")], sourceMessageIds: ["msg-2"], now: NOW });

    const first = await writeback.flush();
    expect(first.written).toBe(0);
    expect(writeback.pending()).toBe(1);

    const second = await writeback.flush();
    expect(second).toMatchObject({ attempted: 1, written: 1, failed: 0 });
    expect(writeback.pending()).toBe(0);
    expect(errors).toEqual([]);
    expect(store.current().records).toHaveLength(1);
  });

  it("连续失败到上限才放弃，并记录原因", async () => {
    const { store, writeback, errors } = setup();
    writeback.enqueue({ candidates: [candidate("想去冰岛")], sourceMessageIds: ["msg-3"], now: NOW });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      store.failNextSave = true;
      await writeback.flush();
    }

    expect(writeback.pending()).toBe(0);
    expect(errors).toEqual(["存储写入失败（注入）"]);
    expect(store.current().records).toEqual([]);
  });

  it("重放已删除的来源不会让记忆复活", async () => {
    const { repo, writeback } = setup();
    writeback.enqueue({ candidates: [candidate("咖啡只喝浅烘焙")], sourceMessageIds: ["msg-4"], now: NOW });
    await writeback.flush();
    const [written] = await repo.list();
    expect(await repo.forget(written.id)).toBe(true);

    // 同一批候选再跑一遍（模型重放、重试到的旧任务）。
    writeback.enqueue({ candidates: [candidate("咖啡只喝浅烘焙")], sourceMessageIds: ["msg-4"], now: NOW });
    await writeback.flush();
    expect(await repo.list()).toEqual([]);
  });

  it("空候选不进队列", async () => {
    const { writeback } = setup();
    writeback.enqueue({ candidates: [], sourceMessageIds: ["msg-5"], now: NOW });
    expect(writeback.pending()).toBe(0);
  });
});
