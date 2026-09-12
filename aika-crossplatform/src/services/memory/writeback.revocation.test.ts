import { describe, expect, it, vi } from "vitest";
import type { MemoryRecord } from "../../domain/memory";
import type { MemoryRepository } from "./memoryRepository";
import { createMemoryMaintenance, type MaintenanceBatch } from "./writeback";

/** RT-04-C：解绑/撤权后，旧队列批次在提交前重新检查。 */
describe("writeback 撤权重查（RT-04-C）", () => {
  function makeRepo() {
    const upsert = vi.fn(async (_records: readonly MemoryRecord[]) => undefined);
    const repository = { upsert, list: vi.fn(async () => [] as MemoryRecord[]) } as unknown as MemoryRepository;
    return { repository, upsert };
  }

  it("授权通过：批次照常写入", async () => {
    const { repository, upsert } = makeRepo();
    const maintenance = createMemoryMaintenance({
      repository,
      authorizeWriteback: async () => ({ ok: true }),
    });
    maintenance.enqueue({ turnId: "t1", sourceMessageIds: ["m1"], candidates: [{ category: "偏好", content: "喜欢喝茶" }] });

    const result = await maintenance.flush("sessionEnd");
    expect(result.written).toBe(1);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(result.denied ?? 0).toBe(0);
  });

  it("撤权后：入队时的批次在提交前被拒，不写入、不重试、可见", async () => {
    const { repository, upsert } = makeRepo();
    // 模拟绑定状态：入队时还在，提交时已解绑。
    let bound = true;
    const maintenance = createMemoryMaintenance({
      repository,
      authorizeWriteback: async () => (bound ? { ok: true } : { ok: false, reason: "binding-revoked" }),
    });
    maintenance.enqueue({ turnId: "t1", sourceMessageIds: ["m1"], candidates: [{ category: "偏好", content: "喜欢喝茶" }] });

    bound = false; // 解绑发生。
    const result = await maintenance.flush("sessionEnd");

    expect(upsert).not.toHaveBeenCalled();
    expect(result.written).toBe(0);
    expect(result.denied).toBe(1);
    expect(result.errors.some((e) => e.startsWith("writeback-denied:"))).toBe(true);
    // 批次被丢弃：不留在队列里反复重试。
    expect(maintenance.pending()).toBe(0);
    expect(maintenance.snapshot().filter((batch: MaintenanceBatch) => batch.id.includes("t1"))).toHaveLength(0);
  });

  it("没提供重查钩子 = legacy 本地链路，行为与之前完全一致", async () => {
    const { repository, upsert } = makeRepo();
    const maintenance = createMemoryMaintenance({ repository });
    maintenance.enqueue({ turnId: "t1", sourceMessageIds: ["m1"], candidates: [{ category: "偏好", content: "喜欢咖啡" }] });

    const result = await maintenance.flush("sessionEnd");
    expect(result.written).toBe(1);
    expect(result.denied ?? 0).toBe(0);
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it("撤权拒绝不影响后续批次的正常提交", async () => {
    const { repository, upsert } = makeRepo();
    const revokedTurns = new Set<string>(["t-revoked"]);
    const maintenance = createMemoryMaintenance({
      repository,
      authorizeWriteback: async (batch) =>
        batch.sourceTurnIds.some((id) => revokedTurns.has(id))
          ? { ok: false, reason: "binding-revoked" }
          : { ok: true },
    });
    maintenance.enqueue({ turnId: "t-revoked", sourceMessageIds: ["m1"], candidates: [{ category: "偏好", content: "被撤权的候选" }] });
    maintenance.enqueue({ turnId: "t-ok", sourceMessageIds: ["m2"], candidates: [{ category: "偏好", content: "仍然有效的候选" }] });

    const result = await maintenance.flush("sessionEnd");
    expect(result.denied).toBe(1);
    expect(result.written).toBe(1);
    expect(upsert).toHaveBeenCalledWith([expect.objectContaining({ content: "仍然有效的候选" })]);
  });
});
