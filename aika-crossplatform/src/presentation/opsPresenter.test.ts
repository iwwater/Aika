import { beforeEach, describe, expect, it } from "vitest";
import type { UsageRecordV1 } from "../domain/usageLedger";
import type { AikaStorage } from "../services/storage/contracts";
import { SETTING_KEYS } from "../services/storage/contracts";
import { createMemoryUsageLedger } from "../services/usage/memoryUsageLedger";
import { createOpsPresenter, type OpsPresenterDeps } from "./opsPresenter";

const BASE = Date.UTC(2026, 0, 10, 12, 0);

function record(overrides: Partial<UsageRecordV1> = {}): UsageRecordV1 {
  return {
    schemaVersion: 1,
    id: "a1",
    logicalRequestId: "r1",
    purpose: "foreground",
    providerId: "prov-a",
    protocol: "openai-compatible",
    model: "model-a",
    startedAt: BASE,
    status: "completed",
    promptTokens: 1_000_000,
    completionTokens: 500_000,
    totalTokens: 1_500_000,
    coverage: "reported",
    ...overrides,
  };
}

interface Fixture {
  presenter: ReturnType<typeof createOpsPresenter>;
  settings: Map<string, string>;
  store: ReturnType<typeof createMemoryUsageLedger>;
  failSaves: { on: boolean };
}

function makeFixture(overrides: Partial<OpsPresenterDeps> = {}): Fixture {
  const store = createMemoryUsageLedger({ clock: () => BASE });
  const settings = new Map<string, string>();
  const failSaves = { on: false };
  const storage = {
    async getSetting(key: string) {
      return settings.get(key) ?? null;
    },
    async setSetting(key: string, value: string) {
      if (failSaves.on) throw new Error("disk full");
      settings.set(key, value);
    },
  } as unknown as AikaStorage;
  const presenter = createOpsPresenter({
    store,
    loadStorage: async () => storage,
    clock: () => BASE,
    ...overrides,
  });
  return { presenter, settings, store, failSaves };
}

beforeEach(() => {
  // 时区固定，断言不随机器漂移。
  process.env.TZ = "UTC";
});

describe("OpsPresenter（FE-26）", () => {
  it("没装台账时 available=false，stats 为 null，页面据此显示没有采集", async () => {
    const fixture = makeFixture({ store: null });
    await fixture.presenter.start();
    const view = fixture.presenter.getSnapshot();
    expect(view.available).toBe(false);
    expect(view.stats).toBeNull();
  });

  it("start 载入第一页并出汇总：金额、错误率、用途覆盖都按台账", async () => {
    const fixture = makeFixture();
    await fixture.store.upsert(record({ id: "a1" }));
    await fixture.store.upsert(record({ id: "a2", status: "failed", coverage: "unknown",
      promptTokens: null, completionTokens: null, totalTokens: null }));
    await fixture.presenter.savePrice({
      id: "", model: "model-a", providerId: "prov-a", currency: "USD",
      effectiveFrom: "2026-01-01", inputPerMillion: 2, outputPerMillion: 8,
    });
    await fixture.presenter.start();

    const view = fixture.presenter.getSnapshot();
    expect(view.available).toBe(true);
    expect(view.stats?.records).toBe(2);
    // a1 全额 6 USD；a2 缺分项不计入。
    expect(view.stats?.costByCurrency).toEqual({ USD: 6 });
    expect(view.stats?.unpricedRecords).toBe(1);
    expect(view.stats?.errorRate).toBe(0.5);
    expect(view.stats?.missingPurposes).toEqual(["maintenance", "summary", "proactive"]);
    // 价目已按版本保存进设置。
    const saved = JSON.parse(fixture.settings.get(SETTING_KEYS.usagePrices) ?? "{}");
    expect(saved.schemaVersion).toBe(1);
    expect(saved.prices).toHaveLength(1);
  });

  it("cursor 翻页累积，覆盖范围说明写清「只覆盖已载入部分」", async () => {
    const fixture = makeFixture({ pageSize: 2 });
    for (let index = 0; index < 3; index += 1) {
      await fixture.store.upsert(record({ id: `a${index}`, startedAt: BASE + index }));
    }
    await fixture.presenter.start();

    let view = fixture.presenter.getSnapshot();
    expect(view.loadedRecords).toBe(2);
    expect(view.hasMore).toBe(true);
    expect(view.coverageNote).toContain("只覆盖已载入部分");

    await fixture.presenter.loadMore();
    view = fixture.presenter.getSnapshot();
    expect(view.loadedRecords).toBe(3);
    expect(view.hasMore).toBe(false);
    expect(view.coverageNote).not.toContain("只覆盖已载入部分");
    expect(view.stats?.records).toBe(3);
  });

  it("refresh 重置到第一页，截断标志不带历史包袱", async () => {
    const fixture = makeFixture({ pageSize: 2 });
    for (let index = 0; index < 3; index += 1) {
      await fixture.store.upsert(record({ id: `a${index}`, startedAt: BASE + index }));
    }
    await fixture.presenter.start();
    await fixture.presenter.loadMore();
    expect(fixture.presenter.getSnapshot().loadedPages).toBe(2);

    await fixture.store.upsert(record({ id: "a9", startedAt: BASE + 99 }));
    await fixture.presenter.refresh();
    const view = fixture.presenter.getSnapshot();
    expect(view.loadedPages).toBe(1);
    expect(view.loadedRecords).toBe(2);
    expect(view.hasMore).toBe(true);
  });

  it("采集关闭时覆盖说明如实标注，新请求不记账的含义可见", async () => {
    const fixture = makeFixture({ isCaptureEnabled: () => false });
    await fixture.presenter.start();
    expect(fixture.presenter.getSnapshot().coverageNote).toContain("采集当前关闭");
  });

  it("非法价目被拒绝且不落库；合法价目落库后参与计价", async () => {
    const fixture = makeFixture();
    await fixture.presenter.start();

    const rejected = await fixture.presenter.savePrice({
      id: "", model: "model-a", providerId: "prov-a", currency: "USD",
      effectiveFrom: "2026-01-01", inputPerMillion: -2, outputPerMillion: 8,
    });
    expect(rejected).toBe(false);
    expect(fixture.presenter.getSnapshot().priceError).toContain("不能为负");
    expect(fixture.settings.has(SETTING_KEYS.usagePrices)).toBe(false);

    const accepted = await fixture.presenter.savePrice({
      id: "", model: "model-a", providerId: "prov-a", currency: "USD",
      effectiveFrom: "2026-01-01", inputPerMillion: 2, outputPerMillion: 8,
    });
    expect(accepted).toBe(true);
    // 空 id 由保存方生成，删除与编辑有稳定定位键。
    const saved = JSON.parse(fixture.settings.get(SETTING_KEYS.usagePrices) ?? "{}");
    expect(saved.prices[0].id).toBeTruthy();
  });

  it("保存失败回滚内存价目并报错，界面与库保持一致", async () => {
    const fixture = makeFixture();
    await fixture.presenter.start();
    fixture.failSaves.on = true;

    const saved = await fixture.presenter.savePrice({
      id: "p1", model: "model-a", providerId: "prov-a", currency: "USD",
      effectiveFrom: "2026-01-01", inputPerMillion: 2, outputPerMillion: 8,
    });
    expect(saved).toBe(false);
    const view = fixture.presenter.getSnapshot();
    expect(view.prices).toHaveLength(0);
    expect(view.priceError).toContain("disk full");
  });

  it("库里的价目损坏时按空价目处理并明说，不冒充空账单", async () => {
    const fixture = makeFixture();
    fixture.settings.set(SETTING_KEYS.usagePrices, "{not json");
    await fixture.presenter.start();
    const view = fixture.presenter.getSnapshot();
    expect(view.prices).toHaveLength(0);
    expect(view.priceError).toContain("损坏");
  });

  it("setTimeZone 改变归日分组", async () => {
    const fixture = makeFixture();
    // 2026-01-01 20:00 UTC = 上海 2026-01-02。
    await fixture.store.upsert(record({ id: "a1", startedAt: Date.UTC(2026, 0, 1, 20, 0) }));
    await fixture.presenter.start();

    fixture.presenter.setTimeZone("Asia/Shanghai");
    expect(fixture.presenter.getSnapshot().stats?.days.map((day) => day.key)).toEqual(["2026-01-02"]);
    expect(fixture.presenter.getSnapshot().timeZone).toBe("Asia/Shanghai");
  });

  it("台账查询失败时错误可见，不显示成空账单", async () => {
    const failing = {
      upsert: async () => undefined,
      query: async () => {
        throw new Error("db locked");
      },
    };
    const fixture = makeFixture({ store: failing as never });
    await fixture.presenter.start();
    const view = fixture.presenter.getSnapshot();
    expect(view.error).toContain("db locked");
  });
});
