import { runMemoryStoreConformance } from "./memoryStore.conformance";
import { createLocalMemoryStore } from "./localMemoryStore";
import { createSqliteMemoryStore, ensureMemorySchema } from "./sqliteMemoryStore";
import { openMemorySqlite } from "../storage/nodeSqlite.harness";

runMemoryStoreConformance({
  name: "localMemoryStore", unsupported: ["searchIds"],
  async create() {
    let fail = false;
    const values = new Map<string, string>();
    return {
      subject: createLocalMemoryStore({ get: (key) => values.get(key) ?? null, set: (key, value) => {
        if (fail) { fail = false; throw new Error("quota exceeded"); }
        values.set(key, value);
      } }),
      failNextSave: () => { fail = true; }, dispose: () => undefined,
    };
  },
});
runMemoryStoreConformance({
  name: "sqliteMemoryStore (node:sqlite)",
  async create() {
    const { db, executor } = openMemorySqlite();
    await executor.execute("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    await ensureMemorySchema(executor);
    let fail = false;
    return {
      subject: createSqliteMemoryStore({ select: executor.select.bind(executor), execute: async (sql, values) => {
        // 在事务内故障，生产 rollback 必须保住旧快照。
        if (fail && sql.startsWith("DELETE")) { fail = false; throw new Error("disk failure"); }
        return executor.execute(sql, values);
      } }),
      failNextSave: () => { fail = true; }, dispose: () => db.close(),
    };
  },
});
