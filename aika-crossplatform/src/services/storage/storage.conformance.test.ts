import { vi } from "vitest";
import { createLocalStorage } from "./localStorageStorage";
import { openMemorySqlite } from "./nodeSqlite.harness";
import { createSqliteStorage } from "./sqliteStorage";
import { runStorageConformance } from "./storage.conformance";

/**
 * 两个 AikaStorage 实现跑同一份用例包。
 *
 * 这是「换实现不改消费侧」的第一份证据：下面两个 harness 的差别只有「怎么造出
 * 被测对象」，断言一条都不为某个实现让路。
 *
 * 两边都走**生产代码**：localStorage 版用 stub 过的 localStorage，SQLite 版用
 * node:sqlite 真实引擎，`createSqliteStorage` 的 SQL 与迁移一字未改。
 */

function installLocalStorage(): () => void {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  });
  return () => vi.unstubAllGlobals();
}

runStorageConformance({
  name: "localStorageStorage",
  // 浏览器回退没有 SQL 引擎，如实声明不支持，而不是造一个假执行器。
  unsupported: ["sqlExecutor"],
  async create() {
    const restore = installLocalStorage();
    return {
      subject: createLocalStorage(),
      async dispose() {
        restore();
      },
    };
  },
});

runStorageConformance({
  name: "sqliteStorage(node:sqlite)",
  async create() {
    const { db, executor } = openMemorySqlite();
    return {
      subject: await createSqliteStorage(executor),
      async dispose() {
        db.close();
      },
    };
  },
});
