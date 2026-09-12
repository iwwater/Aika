import { describe, expect, it } from "vitest";
import { openMemorySqlite } from "../storage/nodeSqlite.harness";
import { createSqliteUsageLedger } from "./sqliteUsageLedger";
import { usageRecord, USAGE_BASE_AT } from "./usageLedger.conformance";

/**
 * SQLite 实现特有的行为：坏行跳过。内存实现没有「坏行」这个概念，
 * 所以不进一致性用例包。
 */
describe("sqliteUsageLedger 特有行为", () => {
  it("payload 损坏的行被跳过，不拖垮整次查询", async () => {
    const { db, executor } = openMemorySqlite();
    const store = await createSqliteUsageLedger(executor, { clock: () => USAGE_BASE_AT });

    await store.upsert(usageRecord({ id: "good-1", logicalRequestId: "r1" }));
    db.exec(
      `INSERT INTO usage_records (id, logical_request_id, turn_id, scope, purpose, provider_id,
         protocol, model, started_at, ended_at, status, payload)
       VALUES ('bad-1', 'r2', NULL, NULL, 'foreground', 'prov-a', 'openai-compatible', 'model-a',
         ${USAGE_BASE_AT}, NULL, 'completed', '{not-json')`,
    );

    const page = await store.query({ limit: 100 });
    expect(page.records.map((record) => record.id)).toEqual(["good-1"]);
  });
});
