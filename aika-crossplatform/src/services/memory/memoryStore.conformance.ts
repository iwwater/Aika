import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMemoryV2 } from "../../domain/memory";
import { emptySnapshot, type MemoryV2Store } from "./memoryStore";

export interface MemoryStoreHarness {
  name: string;
  unsupported?: readonly "searchIds"[];
  create(): Promise<{ subject: MemoryV2Store; failNextSave(): void; dispose(): void }>;
}
export function runMemoryStoreConformance(harness: MemoryStoreHarness) {
  describe(`MemoryV2Store contract: ${harness.name}`, () => {
    let fixture: Awaited<ReturnType<MemoryStoreHarness["create"]>>;
    beforeEach(async () => { fixture = await harness.create(); });
    afterEach(() => fixture.dispose());
    const snapshot = () => ({
      ...emptySnapshot(), migrationVersion: 2,
      records: [createMemoryV2({ id: "coffee", content: "喜欢 coffee", type: "preference", sourceMessageIds: ["msg-1"], now: 1000 })!],
      suppressions: [{ id: "deleted", contentHash: "hash", sourceMessageIds: ["msg-0"], createdAt: 500 }],
    });
    it("快照往返、重复保存幂等、读取与输入不共享可变状态", async () => {
      expect(await fixture.subject.load()).toEqual(emptySnapshot());
      const value = snapshot();
      await fixture.subject.save(value);
      await fixture.subject.save(value);
      expect(await fixture.subject.load()).toEqual(value);
      value.records[0].content = "被修改";
      const read = await fixture.subject.load();
      expect(read.records[0].content).toBe("喜欢 coffee");
      read.records[0].sourceMessageIds.push("fake");
      expect((await fixture.subject.load()).records[0].sourceMessageIds).toEqual(["msg-1"]);
    });
    it("替换删除记录但保留抑制标记，迁移版本不丢失", async () => {
      const value = snapshot();
      await fixture.subject.save(value);
      value.records = [];
      await fixture.subject.save(value);
      expect(await fixture.subject.load()).toEqual(value);
    });
    it("失败显式拒绝且持久化快照保持原样，随后可重试", async () => {
      const value = snapshot();
      await fixture.subject.save(value);
      fixture.failNextSave();
      await expect(fixture.subject.save(emptySnapshot())).rejects.toThrow();
      expect(await fixture.subject.load()).toEqual(value);
      await fixture.subject.save(emptySnapshot());
      expect(await fixture.subject.load()).toEqual(emptySnapshot());
    });
    it("可选搜索能力的声明与实际行为一致", async () => {
      if (harness.unsupported?.includes("searchIds")) {
        expect(fixture.subject.searchIds).toBeUndefined();
      } else {
        expect(fixture.subject.searchIds).toBeTypeOf("function");
        await fixture.subject.save(snapshot());
        expect(await fixture.subject.searchIds!("coffee")).toContain("coffee");
        await fixture.subject.save(emptySnapshot());
        expect(await fixture.subject.searchIds!("coffee")).toEqual([]);
      }
    });
  });
}
