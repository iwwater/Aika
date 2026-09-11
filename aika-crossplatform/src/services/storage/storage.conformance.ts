import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../domain/conversation";
import type { MemoryRecord } from "../../domain/memory";
import type { AikaStorage } from "./contracts";

/**
 * AikaStorage 的端口一致性用例包。
 *
 * 每一个 AikaStorage 实现都要跑这一份。它只断言**契约层面可观测的行为**：
 * 写进去读得到、删掉读不到、排序如何、可选能力缺失时给什么信号。
 *
 * 它刻意不断言 SQL 语句、不断言 localStorage 键名——那些是实现细节，写进用例包
 * 就等于把两个实现焊死，以后谁也换不了。这也是现有 sqliteStorage.test.ts 和
 * storageCompatibility.test.ts 换个实现一条都跑不了的原因。
 *
 * 这份用例包证明的是**行为契约可替换**，不证明性能、并发与持久性等价：
 * SQLite 的事务性和 localStorage 的非原子性显然不是一回事。
 */

/** 可选能力。实现要么支持并通过对应用例，要么在 unsupported 里明说。 */
export const STORAGE_OPTIONAL = ["memoryV2", "deleteSummaries"] as const;
export type StorageOptional = (typeof STORAGE_OPTIONAL)[number];

export interface PortHarness<T> {
  name: string;
  create(): Promise<{ subject: T; dispose(): Promise<void> }>;
  /**
   * 这个实现明确不支持的可选能力。
   * 声明会被验证：说不支持就必须真的不支持，说支持（不声明）就必须真的能用。
   * 静默跳过是稀释用例包最常见的方式，这里堵死。
   */
  unsupported?: readonly string[];
}

function message(id: string, createdAt: number, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    role: "user",
    content: `内容 ${id}`,
    createdAt,
    time: "12:00",
    source: "text",
    ...overrides,
  };
}

function memory(id: string, createdAt: number): MemoryRecord {
  return {
    id,
    category: "日常",
    content: `记忆 ${id}`,
    status: "pending",
    createdAt,
    updatedAt: createdAt,
  };
}

export function runStorageConformance(harness: PortHarness<AikaStorage>): void {
  const unsupported = new Set(harness.unsupported ?? []);
  const supports = (capability: StorageOptional) => !unsupported.has(capability);

  describe(`AikaStorage 契约 · ${harness.name}`, () => {
    async function withStorage<T>(run: (storage: AikaStorage) => Promise<T>): Promise<T> {
      const { subject, dispose } = await harness.create();
      try {
        return await run(subject);
      } finally {
        await dispose();
      }
    }

    it("kind 是稳定标识", async () => {
      await withStorage(async (storage) => {
        expect(["sqlite", "local"]).toContain(storage.kind);
      });
    });

    it("写入的消息读得回来，且按时间正序", async () => {
      await withStorage(async (storage) => {
        await storage.appendMessage(message("b", 200));
        await storage.appendMessage(message("a", 100));
        await storage.appendMessage(message("c", 300));

        const messages = await storage.listMessages(10);

        expect(messages.map((item) => item.id)).toEqual(["a", "b", "c"]);
        expect(messages[0].content).toBe("内容 a");
      });
    });

    it("limit 取最近的那几条，不是最早的", async () => {
      await withStorage(async (storage) => {
        for (const [index, id] of ["a", "b", "c", "d"].entries()) {
          await storage.appendMessage(message(id, 100 + index * 100));
        }

        expect((await storage.listMessages(2)).map((item) => item.id)).toEqual(["c", "d"]);
      });
    });

    it("同一个 id 再写是替换，不是追加", async () => {
      await withStorage(async (storage) => {
        await storage.appendMessage(message("a", 100));
        await storage.appendMessage(message("a", 100, { content: "改过了" }));

        const messages = await storage.listMessages(10);

        expect(messages).toHaveLength(1);
        expect(messages[0].content).toBe("改过了");
      });
    });

    it("runtimeTurnId 与旧 turnId 并存，读旧数据不回填假值", async () => {
      await withStorage(async (storage) => {
        // 新数据：两个 id 都在。它们是两回事——turnId 是语音回合号（number，
        // 已经落在库里），runtimeTurnId 是 Runtime 的 uuid。
        await storage.appendMessage(message("new", 100, {
          turnId: 7,
          runtimeTurnId: "run-abc",
        }));
        // 旧数据：只有 turnId，没有 runtimeTurnId。
        await storage.appendMessage(message("old", 50, { turnId: 3 }));

        const rows = await storage.listMessages(10);
        const fresh = rows.find((item) => item.id === "new");
        const legacy = rows.find((item) => item.id === "old");

        expect(fresh).toMatchObject({ turnId: 7, runtimeTurnId: "run-abc" });
        // 缺失就是缺失：不许回填空串、0 或任何占位值。
        expect(legacy?.turnId).toBe(3);
        expect(legacy?.runtimeTurnId).toBeUndefined();
      });
    });

    it("时间戳只统计非错误消息", async () => {
      await withStorage(async (storage) => {
        await storage.appendMessage(message("ok", 100));
        await storage.appendMessage(message("bad", 200, { error: true }));

        expect(await storage.listMessageTimestamps()).toEqual([100]);
      });
    });

    it("计数按时间下界，主动消息单独计", async () => {
      await withStorage(async (storage) => {
        await storage.appendMessage(message("old", 100));
        await storage.appendMessage(message("new", 300));
        await storage.appendMessage(message("push", 400, { source: "proactive" }));

        expect(await storage.countMessagesSince(300)).toBe(2);
        expect(await storage.countProactiveSince(300)).toBe(1);
        expect(await storage.countProactiveSince(500)).toBe(0);
      });
    });

    it("按 id 删除消息：删掉的读不到，没列出的一条不动", async () => {
      await withStorage(async (storage) => {
        for (const [index, id] of ["a", "b", "c"].entries()) {
          await storage.appendMessage(message(id, 100 + index * 100));
        }

        await storage.deleteMessages(["a", "c"]);

        const messages = await storage.listMessages(10);
        expect(messages.map((item) => item.id)).toEqual(["b"]);
        expect(messages[0].content).toBe("内容 b");
      });
    });

    it("删除是幂等的：未知 id、重复删、空数组都不出错", async () => {
      await withStorage(async (storage) => {
        await storage.appendMessage(message("a", 100));

        // 「删不掉」没有合理的降级，所以这三种调用都必须安静地成功。
        await storage.deleteMessages(["nope"]);
        await storage.deleteMessages([]);
        await storage.deleteMessages(["a"]);
        await storage.deleteMessages(["a"]);

        expect(await storage.listMessages(10)).toEqual([]);
      });
    });

    it("删除后派生查询跟着变：时间戳与两种计数都对齐剩余消息", async () => {
      await withStorage(async (storage) => {
        await storage.appendMessage(message("keep", 100));
        await storage.appendMessage(message("gone", 300));
        await storage.appendMessage(message("push", 400, { source: "proactive" }));

        await storage.deleteMessages(["gone", "push"]);

        expect(await storage.listMessageTimestamps()).toEqual([100]);
        expect(await storage.countMessagesSince(0)).toBe(1);
        expect(await storage.countMessagesSince(300)).toBe(0);
        expect(await storage.countProactiveSince(0)).toBe(0);
      });
    });

    it("删除消息不连带作废摘要、也不动记忆", async () => {
      await withStorage(async (storage) => {
        // 与 clearMessages 的分界：删一条最近的失败消息不该触发整段摘要重压缩。
        await storage.appendMessage(message("a", 100));
        await storage.saveSummary({ content: "摘要", coversUntil: 100, createdAt: 100 });
        await storage.addMemories([memory("m1", 100)]);

        await storage.deleteMessages(["a"]);

        expect((await storage.latestSummary())?.content).toBe("摘要");
        expect((await storage.listMemories()).map((item) => item.id)).toEqual(["m1"]);
      });
    });

    it("清空消息会连摘要一起作废", async () => {
      await withStorage(async (storage) => {
        await storage.appendMessage(message("a", 100));
        await storage.saveSummary({ content: "摘要", coversUntil: 100, createdAt: 100 });

        await storage.clearMessages();

        expect(await storage.listMessages(10)).toEqual([]);
        expect(await storage.latestSummary()).toBeNull();
      });
    });

    it("记忆写入、改状态、删除各自生效", async () => {
      await withStorage(async (storage) => {
        await storage.addMemories([memory("m1", 100), memory("m2", 200)]);
        expect((await storage.listMemories()).map((item) => item.id).sort()).toEqual(["m1", "m2"]);

        await storage.setMemoryStatus("m1", "confirmed");
        const confirmed = (await storage.listMemories()).find((item) => item.id === "m1");
        expect(confirmed?.status).toBe("confirmed");

        await storage.deleteMemory("m2");
        expect((await storage.listMemories()).map((item) => item.id)).toEqual(["m1"]);
      });
    });

    it("同 id 的记忆再写是替换", async () => {
      await withStorage(async (storage) => {
        await storage.addMemories([memory("m1", 100)]);
        await storage.addMemories([{ ...memory("m1", 100), content: "改过了" }]);

        const memories = await storage.listMemories();

        expect(memories).toHaveLength(1);
        expect(memories[0].content).toBe("改过了");
      });
    });

    it("最新摘要是最后存进去的那条；没有就是 null", async () => {
      await withStorage(async (storage) => {
        expect(await storage.latestSummary()).toBeNull();

        await storage.saveSummary({ content: "旧", coversUntil: 100, createdAt: 100 });
        await storage.saveSummary({ content: "新", coversUntil: 200, createdAt: 200 });

        expect((await storage.latestSummary())?.content).toBe("新");
      });
    });

    it("设置读写往返；没写过的键返回 null", async () => {
      await withStorage(async (storage) => {
        expect(await storage.getSetting("never.written")).toBeNull();

        await storage.setSetting("some.key", "值");
        expect(await storage.getSetting("some.key")).toBe("值");

        await storage.setSetting("some.key", "新值");
        expect(await storage.getSetting("some.key")).toBe("新值");
      });
    });

    // 可选能力：声明与事实必须一致，两个方向都验。
    it(`deleteSummaries：${supports("deleteSummaries") ? "声明支持就必须能用" : "声明不支持就必须真的不在"}`, async () => {
      await withStorage(async (storage) => {
        if (!supports("deleteSummaries")) {
          expect(storage.deleteSummaries).toBeUndefined();
          return;
        }
        expect(typeof storage.deleteSummaries).toBe("function");
        await storage.saveSummary({ content: "摘要", coversUntil: 100, createdAt: 100 });
        await storage.deleteSummaries?.();
        expect(await storage.latestSummary()).toBeNull();
      });
    });

    it(`memoryV2：${supports("memoryV2") ? "声明支持就必须能读写快照" : "声明不支持就必须真的不在"}`, async () => {
      await withStorage(async (storage) => {
        if (!supports("memoryV2")) {
          expect(storage.memoryV2).toBeUndefined();
          return;
        }
        expect(storage.memoryV2).toBeDefined();
        const snapshot = await storage.memoryV2?.load();
        expect(snapshot).toBeDefined();
        expect(Array.isArray(snapshot?.records)).toBe(true);
      });
    });
  });
}
