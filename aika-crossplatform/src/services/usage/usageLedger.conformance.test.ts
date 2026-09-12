import { describe } from "vitest";
import { openMemorySqlite } from "../storage/nodeSqlite.harness";
import { createMemoryUsageLedger } from "./memoryUsageLedger";
import { createSqliteUsageLedger } from "./sqliteUsageLedger";
import { runUsageLedgerConformance, USAGE_BASE_AT, type UsageLedgerHarness } from "./usageLedger.conformance";

/**
 * 两个台账实现跑同一份端口一致性用例包（LLM-12-C：SQLite 与浏览器临时存储
 * 提供相同读写语义）。内存实现不提供 reopen——「临时」是它的如实含义，
 * 重启恢复只由 SQLite 实现承诺。
 */
function memoryHarness(): UsageLedgerHarness {
  return {
    name: "memoryUsageLedger（浏览器临时台账）",
    async create() {
      const subject = createMemoryUsageLedger({ clock: () => USAGE_BASE_AT });
      return { subject, dispose: async () => undefined };
    },
  };
}

function sqliteHarness(): UsageLedgerHarness {
  return {
    name: "sqliteUsageLedger（SQLite 落盘台账）",
    async create() {
      const { executor } = openMemorySqlite();
      const subject = await createSqliteUsageLedger(executor, { clock: () => USAGE_BASE_AT });
      return {
        subject,
        dispose: async () => undefined,
        reopen: async () => createSqliteUsageLedger(executor, { clock: () => USAGE_BASE_AT }),
      };
    },
  };
}

describe("UsageLedgerStore 端口一致性", () => {
  runUsageLedgerConformance(memoryHarness());
  runUsageLedgerConformance(sqliteHarness());
});
