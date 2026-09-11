import { openMemorySqlite } from "../storage/nodeSqlite.harness";
import { createMemoryTraceSink } from "./memoryTraceSink";
import { createSqliteTraceSink } from "./sqliteTraceSink";
import { runTraceSinkConformance, TRACE_BASE_AT } from "./trace.conformance";

/**
 * 两个 TraceSink 实现跑同一份用例包。
 *
 * 两边都走生产代码：内存实现就是它本身，SQLite 实现用 node:sqlite 真实引擎跑
 * 生产 SQL（建表、INSERT OR REPLACE、索引、清理语句一字未改）。
 */

runTraceSinkConformance({
  name: "memoryTraceSink",
  async create() {
    return {
      subject: createMemoryTraceSink(500),
      async dispose() {
        // 内存实现无需释放。
      },
    };
  },
});

runTraceSinkConformance({
  name: "sqliteTraceSink(node:sqlite)",
  async create() {
    const { db, executor } = openMemorySqlite();
    // 时钟钉在用例包的基准上，保留期清理才不会把用例自己的事件当成过期数据。
    const subject = await createSqliteTraceSink(executor, { clock: () => TRACE_BASE_AT + 1000 });
    return {
      subject,
      breakWrites() {
        // 把表删掉就是最真实的写入失败：后续 INSERT 一定报 no such table。
        db.exec("DROP TABLE trace_events");
      },
      async dispose() {
        db.close();
      },
    };
  },
});
