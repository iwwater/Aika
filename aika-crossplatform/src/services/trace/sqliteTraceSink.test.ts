import { describe, expect, it } from "vitest";
import { openMemorySqlite } from "../storage/nodeSqlite.harness";
import { createSqliteTraceSink, DEFAULT_TRACE_RETENTION_DAYS } from "./sqliteTraceSink";
import { traceEvent, TRACE_BASE_AT } from "./trace.conformance";

/**
 * 落盘实现自己的两件事：保留期清理与 append 不阻塞。
 * 契约层面的行为在 trace.conformance 里，两个实现共用，不在这里重复。
 */

const DAY = 86_400_000;

describe("sqliteTraceSink 保留策略", () => {
  it("超过保留期的清掉，期内的一条不动", async () => {
    const { db, executor } = openMemorySqlite();
    let now = TRACE_BASE_AT;
    const sink = await createSqliteTraceSink(executor, {
      clock: () => now,
      retentionDays: DEFAULT_TRACE_RETENTION_DAYS,
      sweepIntervalMs: 0,
    });

    // 一条 8 天前、一条 1 天前
    sink.append(traceEvent("old", 1, TRACE_BASE_AT - 8 * DAY));
    sink.append(traceEvent("fresh", 1, TRACE_BASE_AT - 1 * DAY));
    await sink.flush();

    const left = (await sink.query({})).map((event) => event.turnId);
    expect(left).toEqual(["fresh"]);

    // 时钟再往后走 7 天，刚才那条也过期了：下一次写入顺带把它带走。
    now = TRACE_BASE_AT + 7 * DAY;
    sink.append(traceEvent("newest", 1, now));
    await sink.flush();

    expect((await sink.query({})).map((event) => event.turnId)).toEqual(["newest"]);
    db.close();
  });

  it("清理有节流：间隔内不重复扫表", async () => {
    const { db, executor } = openMemorySqlite();
    const statements: string[] = [];
    const spy = {
      execute: async (query: string, values?: unknown[]) => {
        statements.push(query);
        return executor.execute(query, values);
      },
      select: <T,>(query: string, values?: unknown[]) => executor.select<T>(query, values),
    };
    const sink = await createSqliteTraceSink(spy, { clock: () => TRACE_BASE_AT, sweepIntervalMs: 60_000 });

    sink.append(traceEvent("a", 1, TRACE_BASE_AT));
    sink.append(traceEvent("b", 1, TRACE_BASE_AT));
    sink.append(traceEvent("c", 1, TRACE_BASE_AT));
    await sink.flush();

    const sweeps = statements.filter((query) => query.startsWith("DELETE FROM trace_events"));
    expect(sweeps).toHaveLength(1);
    db.close();
  });

  it("append 不返回 Promise，也不等落盘——主链路不该被 Trace 拖住", async () => {
    const { db, executor } = openMemorySqlite();
    const sink = await createSqliteTraceSink(executor, { clock: () => TRACE_BASE_AT });

    const returned = sink.append(traceEvent("t1", 1, TRACE_BASE_AT));

    expect(returned).toBeUndefined();
    // 还没 flush，库里就还没有这一条：证明它真的是排队而不是同步写。
    expect(await executor.select<unknown[]>("SELECT * FROM trace_events")).toEqual([]);
    await sink.flush();
    expect(await sink.query({ turnId: "t1" })).toHaveLength(1);
    db.close();
  });
});
