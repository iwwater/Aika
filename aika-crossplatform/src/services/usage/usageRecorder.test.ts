import { describe, expect, it } from "vitest";
import type { UsageRecordV1 } from "../../domain/usageLedger";
import type { ProviderConfig } from "../../domain/providers";
import { USAGE_BASE_AT } from "./usageLedger.conformance";
import type { ProviderRequestOptions, RequestUsageSample } from "../providerClient";
import type { UsageLedgerStore, UsageLedgerRecorder, UsageRecorderDiagnostics } from "./contracts";
import { createUsageLedgerRecorder, type UsageRecorderOptions } from "./usageRecorder";

const config: ProviderConfig = {
  id: "prov-test",
  name: "Test",
  protocol: "anthropic",
  baseUrl: "https://relay.example/v1",
  model: "test-model",
  apiKey: "sk-CANARY-SECRET-123",
};

interface Setup {
  recorder: UsageLedgerRecorder;
  /** 按 id 幂等后的最终状态——与真实 store 的 INSERT OR REPLACE 语义一致。 */
  records(): UsageRecordV1[];
  diagnostics(): UsageRecorderDiagnostics;
  /** 让下一次 upsert 挂起，模拟慢存储。 */
  block(): void;
  /** 放行挂起的 upsert。 */
  unblock(): void;
}

function makeSetup(overrides: Partial<UsageRecorderOptions> & { upsertRejects?: boolean } = {}): Setup {
  const byId = new Map<string, UsageRecordV1>();
  let gate: Promise<void> | null = null;
  let openGate: (() => void) | null = null;
  const store: UsageLedgerStore = {
    upsert: async (record) => {
      if (gate) await gate;
      if (overrides.upsertRejects) throw new Error("disk on fire");
      byId.set(record.id, JSON.parse(JSON.stringify(record)) as UsageRecordV1);
    },
    query: async () => ({ records: [], nextCursor: null, truncated: false }),
  };
  let counter = 0;
  let now = USAGE_BASE_AT;
  const recorder = createUsageLedgerRecorder({
    store,
    clock: () => (now += 10),
    idFactory: () => `att-${++counter}`,
    ...overrides,
  });
  return {
    recorder,
    records: () => [...byId.values()],
    diagnostics: () => recorder.diagnostics(),
    block: () => {
      gate = new Promise<void>((resolve) => {
        openGate = resolve;
      });
    },
    unblock: () => {
      gate = null;
      openGate?.();
    },
  };
}

function observe(setup: Setup, overrides: Partial<Parameters<UsageLedgerRecorder["observe"]>[0]> = {}) {
  return setup.recorder.observe({ config, purpose: "foreground", ...overrides });
}

function emit(
  wired: ProviderRequestOptions,
  logicalRequestId: string,
  attempt: number,
  phase: RequestUsageSample["phase"],
  usage?: RequestUsageSample["usage"],
): void {
  wired.onRequestUsage?.({ logicalRequestId, attempt, phase, ...(usage ? { usage } : {}) });
}

async function flushWrites(): Promise<void> {
  // drain 是微任务链，一个宏任务等待足以让它清空。
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("用量台账 recorder（LLM-12）", () => {
  it("成功尝试：一条 reported 记录，providerId/protocol/model 来自真实配置", async () => {
    const setup = makeSetup();
    const wired = observe(setup, { purpose: "foreground", turnId: "t-1" });
    emit(wired, "req-1", 1, "started");
    emit(wired, "req-1", 1, "completed", { promptTokens: 100, completionTokens: 50, totalTokens: 150 });
    await flushWrites();

    const records = setup.records();
    expect(records).toHaveLength(1);
    const record = records[0];
    expect(record).toMatchObject({
      schemaVersion: 1,
      logicalRequestId: "req-1",
      turnId: "t-1",
      purpose: "foreground",
      providerId: "prov-test",
      protocol: "anthropic",
      model: "test-model",
      status: "completed",
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      coverage: "reported",
    });
    expect(record.startedAt).toBeLessThan(record.endedAt ?? 0);
    expect(setup.diagnostics().registered).toBe(1);
  });

  it("重试/回退是独立 attempt：同一 logicalRequestId，两条记录不重复汇总", async () => {
    const setup = makeSetup();
    const wired = observe(setup, { purpose: "foreground" });
    emit(wired, "req-1", 1, "started");
    emit(wired, "req-1", 1, "failed");
    emit(wired, "req-1", 2, "started");
    emit(wired, "req-1", 2, "completed", { promptTokens: 80, completionTokens: 40, totalTokens: 120 });
    await flushWrites();

    const records = setup.records();
    expect(records).toHaveLength(2);
    const [first, second] = records;
    expect(first.status).toBe("failed");
    expect(first.coverage).toBe("unknown");
    expect(first.promptTokens).toBeNull();
    expect(second.status).toBe("completed");
    expect(second.totalTokens).toBe(120);
    expect(first.id).not.toBe(second.id);
    expect(first.logicalRequestId).toBe(second.logicalRequestId);
    expect(setup.diagnostics().registered).toBe(2);
  });

  it("取消与失败：没有用量就是 unknown，不冒充 0", async () => {
    const setup = makeSetup();
    const cancel = observe(setup, { purpose: "foreground" });
    emit(cancel, "req-c", 1, "started");
    emit(cancel, "req-c", 1, "cancelled");

    const fail = observe(setup, { purpose: "foreground" });
    emit(fail, "req-f", 1, "started");
    emit(fail, "req-f", 1, "failed");
    await flushWrites();

    expect(setup.records().map((record) => record.status)).toEqual(["cancelled", "failed"]);
    for (const record of setup.records()) {
      expect(record.coverage).toBe("unknown");
      expect(record.totalTokens).toBeNull();
    }
  });

  it("断流前已收到的部分用量如实保留（partial）", async () => {
    const setup = makeSetup();
    const wired = observe(setup, { purpose: "foreground" });
    emit(wired, "req-p", 1, "started");
    emit(wired, "req-p", 1, "cancelled", { promptTokens: 512, completionTokens: null, totalTokens: null });
    await flushWrites();

    expect(setup.records()).toHaveLength(1);
    expect(setup.records()[0].status).toBe("cancelled");
    expect(setup.records()[0].coverage).toBe("partial");
    expect(setup.records()[0].promptTokens).toBe(512);
  });

  it("只收到 total：保留 total，分项仍 null，coverage=partial（LLM-12-B）", async () => {
    const setup = makeSetup();
    const wired = observe(setup, { purpose: "foreground" });
    emit(wired, "req-t", 1, "started");
    emit(wired, "req-t", 1, "completed", { promptTokens: null, completionTokens: null, totalTokens: 77 });
    await flushWrites();

    expect(setup.records()[0]).toMatchObject({
      totalTokens: 77, promptTokens: null, completionTokens: null, coverage: "partial",
    });
  });

  it("显式 0 是数字不是未知：coverage=reported，token 为 0（LLM-12-B）", async () => {
    const setup = makeSetup();
    const wired = observe(setup, { purpose: "foreground" });
    emit(wired, "req-0", 1, "started");
    emit(wired, "req-0", 1, "completed", { promptTokens: 0, completionTokens: 0, totalTokens: 0 });
    await flushWrites();

    expect(setup.records()[0]).toMatchObject({
      promptTokens: 0, completionTokens: 0, totalTokens: 0, coverage: "reported",
    });
  });

  it("末包 usage 缺失：终态照记，coverage=unknown（LLM-12-B）", async () => {
    const setup = makeSetup();
    const wired = observe(setup, { purpose: "maintenance" });
    emit(wired, "req-m", 1, "started");
    emit(wired, "req-m", 1, "completed");
    await flushWrites();

    expect(setup.records()[0]).toMatchObject({
      status: "completed", purpose: "maintenance", coverage: "unknown", totalTokens: null,
    });
  });

  it("摘要用途与未知用途由调用方显式赋值（LLM-12-A）", async () => {
    const setup = makeSetup();
    const summary = observe(setup, { purpose: "summary" });
    emit(summary, "req-s", 1, "started");
    emit(summary, "req-s", 1, "completed", { promptTokens: 1, completionTokens: 2, totalTokens: 3 });

    const unknown = observe(setup, { purpose: "unknown" });
    emit(unknown, "req-u", 1, "started");
    emit(unknown, "req-u", 1, "completed");
    await flushWrites();

    expect(setup.records().map((record) => record.purpose)).toEqual(["summary", "unknown"]);
    // unknown 不显式设置 requestPurpose，交给 providerClient 的未声明默认。
    expect(unknown.requestPurpose).toBeUndefined();
    expect(summary.requestPurpose).toBe("summary");
  });

  it("采集关闭：0 条新记录，诊断也是 0（LLM-12-D）", async () => {
    const setup = makeSetup({ isEnabled: () => false });
    const wired = observe(setup, { purpose: "foreground" });
    emit(wired, "req-x", 1, "started");
    emit(wired, "req-x", 1, "completed", { promptTokens: 5, completionTokens: 5, totalTokens: 10 });
    await flushWrites();

    expect(setup.records()).toHaveLength(0);
    const diagnostics = setup.diagnostics();
    expect(diagnostics.registered).toBe(0);
    expect(diagnostics.writeFailures).toBe(0);
  });

  it("开始时采集开着、半途关掉：已登记的尝试照常写完，不留半条", async () => {
    let enabled = true;
    const setup = makeSetup({ isEnabled: () => enabled });
    const wired = observe(setup, { purpose: "foreground" });
    emit(wired, "req-h", 1, "started");
    enabled = false;
    emit(wired, "req-h", 1, "completed", { promptTokens: 5, completionTokens: 5, totalTokens: 10 });
    await flushWrites();

    expect(setup.records()).toHaveLength(1);
    expect(setup.records()[0].status).toBe("completed");
    expect(setup.records()[0].coverage).toBe("reported");
  });

  it("同一逻辑请求中途开关翻转不产生半截记录：第二次尝试保持沉默", async () => {
    let enabled = true;
    const setup = makeSetup({ isEnabled: () => enabled });
    const wired = observe(setup, { purpose: "foreground" });
    emit(wired, "req-half", 1, "started");
    enabled = false;
    emit(wired, "req-half", 1, "failed");
    emit(wired, "req-half", 2, "started");
    emit(wired, "req-half", 2, "completed", { promptTokens: 1, completionTokens: 1, totalTokens: 2 });
    await flushWrites();

    // 第一次尝试已登记，写完；重试开始时采集已关，整条沉默。
    expect(setup.records()).toHaveLength(1);
    expect(setup.records()[0].status).toBe("failed");
  });

  it("secret canary 不落库：记录里没有 apiKey，也没有完整 URL（LLM-12-D）", async () => {
    const setup = makeSetup();
    const wired = observe(setup, { purpose: "foreground" });
    emit(wired, "req-k", 1, "started");
    emit(wired, "req-k", 1, "completed", { promptTokens: 1, completionTokens: 1, totalTokens: 2 });
    await flushWrites();

    const dump = JSON.stringify(setup.records());
    expect(dump).not.toContain("sk-CANARY-SECRET-123");
    expect(dump).not.toContain("relay.example");
  });

  it("写失败旁路化：不抛、计数可见，不影响 observe 与样本接收（LLM-12-C）", async () => {
    const setup = makeSetup({ upsertRejects: true });
    const wired = observe(setup, { purpose: "foreground" });
    expect(() => emit(wired, "req-b", 1, "started")).not.toThrow();
    expect(() => emit(wired, "req-b", 1, "completed", { promptTokens: 1, completionTokens: 1, totalTokens: 2 })).not.toThrow();
    await flushWrites();

    expect(setup.records()).toHaveLength(0);
    expect(setup.diagnostics().writeFailures).toBe(2);
    expect(setup.diagnostics().registered).toBe(1);
  });

  it("待写队列有界：满了丢最旧并计数，存储永不背无界内存（LLM-12-C）", async () => {
    const setup = makeSetup({ queueLimit: 2 });
    setup.block();
    const wired = observe(setup, { purpose: "foreground" });
    for (let index = 1; index <= 5; index += 1) {
      emit(wired, `req-q${index}`, 1, "started");
      emit(wired, `req-q${index}`, 1, "completed", { promptTokens: index, completionTokens: 0, totalTokens: index });
    }
    // 五次尝试 × 两笔写入：1 条已出队正在挂起写入 + 2 条占着队列，其余 7 条被丢弃并计数。
    expect(setup.diagnostics().dropped).toBe(7);
    expect(setup.diagnostics().registered).toBe(5);
    setup.unblock();
    await flushWrites();
    // 存活的是最早那条（挂起中的）与最新那次尝试，终态由后写覆盖。
    expect(setup.records()).toHaveLength(2);
    expect(setup.records().map((record) => record.status)).toEqual(["completed", "completed"]);
  });

  it("并发逻辑请求互不串扰：各自的 started/终态按 attempt 配对", async () => {
    const setup = makeSetup();
    const a = observe(setup, { purpose: "foreground" });
    const b = observe(setup, { purpose: "maintenance" });
    emit(a, "req-a", 1, "started");
    emit(b, "req-b", 1, "started");
    emit(b, "req-b", 1, "completed", { promptTokens: 9, completionTokens: 9, totalTokens: 18 });
    emit(a, "req-a", 1, "cancelled");
    await flushWrites();

    expect(setup.records()).toHaveLength(2);
    const byLogical = new Map(setup.records().map((record) => [record.logicalRequestId, record]));
    expect(byLogical.get("req-a")).toMatchObject({ status: "cancelled", purpose: "foreground" });
    expect(byLogical.get("req-b")).toMatchObject({ status: "completed", purpose: "maintenance", totalTokens: 18 });
  });

  it("scope 由装配提供；不提供就无 scope 字段", async () => {
    const scoped = makeSetup({ scope: () => "char-1" });
    const wired = observe(scoped, { purpose: "foreground" });
    emit(wired, "req-s1", 1, "started");
    emit(wired, "req-s1", 1, "completed");
    await flushWrites();
    expect(scoped.records()[0].scope).toBe("char-1");

    const unscoped = makeSetup();
    const wired2 = unscoped.recorder.observe({ config, purpose: "foreground" });
    emit(wired2, "req-s2", 1, "started");
    emit(wired2, "req-s2", 1, "completed");
    await flushWrites();
    expect("scope" in unscoped.records()[0]).toBe(false);
  });

  it("有终态没 started 的异常路径：按此刻补登记，不留死角", async () => {
    const setup = makeSetup();
    const wired = observe(setup, { purpose: "foreground" });
    emit(wired, "req-o", 1, "completed", { promptTokens: 2, completionTokens: 3, totalTokens: 5 });
    await flushWrites();

    expect(setup.records()).toHaveLength(1);
    const record = setup.records()[0];
    expect(record.status).toBe("completed");
    expect(record.startedAt).toBe(record.endedAt);
    expect(setup.diagnostics().registered).toBe(1);
  });
});
