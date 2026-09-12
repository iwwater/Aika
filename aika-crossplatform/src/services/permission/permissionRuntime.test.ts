import { describe, expect, it } from "vitest";
import type { AikaStorage } from "../storage/contracts";
import { createDefaultPolicy, createDenyAllPolicy } from "./permissionPolicy";
import { createPermissionStore } from "./permissionStore";
import { createPermissionRuntime, type PermissionRuntime } from "./permissionRuntime";

const BASE = Date.UTC(2026, 0, 10, 12, 0);
const WS = "C:\\work\\aika";

interface Fixture {
  runtime: PermissionRuntime;
  settings: Map<string, string>;
  now: number;
  tick(ms: number): void;
}

function makeFixture(policy = createDefaultPolicy()): Fixture {
  const settings = new Map<string, string>();
  let now = BASE;
  let seq = 0;
  const storage = {
    async getSetting(key: string) { return settings.get(key) ?? null; },
    async setSetting(key: string, value: string) { settings.set(key, value); },
  } as unknown as AikaStorage;
  const store = createPermissionStore(async () => storage);
  const runtime = createPermissionRuntime({
    store,
    policy,
    clock: () => now,
    idFactory: () => `id-${(seq += 1).toString().padStart(4, "0")}-0000`,
  });
  return { runtime, settings, now, tick: (ms: number) => { now += ms; } };
}

async function makeWriteRequest(fixture: Fixture, overrides: Partial<Parameters<PermissionRuntime["request"]>[0]> = {}) {
  const result = await fixture.runtime.request({
    principalId: "ext-A",
    conversationId: "conv-A",
    category: "write",
    kind: "file.write",
    params: { files: ["src/a.ts"] },
    workspace: WS,
    targetPath: "src/a.ts",
    ...overrides,
  });
  if (!result.ok) throw new Error(`request failed: ${result.reason}`);
  return result;
}

describe("Permission Runtime（RT-03）", () => {
  it("自动放行只给 read；write/execute/external 要审批（RT-03-D）", async () => {
    const fixture = makeFixture();
    const read = await fixture.runtime.request({
      principalId: "local", conversationId: "local",
      category: "read", kind: "file.read", workspace: WS, targetPath: "src/x.ts",
    });
    expect(read.ok && read.autoAllowed).toBe(true);

    for (const category of ["write", "execute", "external"] as const) {
      const result = await makeWriteRequest(fixture, { category, kind: `${category}.thing`, targetPath: undefined, workspace: undefined });
      expect(result.autoAllowed).toBe(false);
      expect(result.record.state).toBe("pending");
    }
  });

  it("重放拒绝：认领恰好一次，第二次 already-consumed（RT-03-A）", async () => {
    const fixture = makeFixture();
    const { record } = await makeWriteRequest(fixture);
    await fixture.runtime.approve({ requestId: record.request.requestId, by: { principalId: "local" } });

    const first = await fixture.runtime.authorizeExecution({ requestId: record.request.requestId, executionId: "exec-1", nonce: record.request.nonce });
    expect(first.ok).toBe(true);

    const replay = await fixture.runtime.authorizeExecution({ requestId: record.request.requestId, executionId: "exec-2", nonce: record.request.nonce });
    expect(replay).toEqual({ ok: false, reason: "already-consumed" });
  });

  it("跨用户拒绝：非本人（本地除外）不能批也不能执行（RT-03-A）", async () => {
    const fixture = makeFixture();
    const { record } = await makeWriteRequest(fixture);

    // 外部主体 B 不能批 A 的请求。
    const approve = await fixture.runtime.approve({ requestId: record.request.requestId, by: { principalId: "ext-B" } });
    expect(approve).toEqual({ ok: false, reason: "approver-not-authorized" });

    // A 批准后，B 试图以自己的身份认领执行：principal 不匹配。
    await fixture.runtime.approve({ requestId: record.request.requestId, by: { principalId: "local" } });
    const claim = await fixture.runtime.authorizeExecution({
      requestId: record.request.requestId, executionId: "exec-1",
      nonce: record.request.nonce, byPrincipalId: "ext-B",
    });
    expect(claim).toEqual({ ok: false, reason: "principal-mismatch" });
  });

  it("跨会话拒绝：agentSession 不匹配（RT-03-A）", async () => {
    const fixture = makeFixture();
    const { record } = await makeWriteRequest(fixture, { agentSessionId: "session-1" });
    await fixture.runtime.approve({ requestId: record.request.requestId, by: { principalId: "local" } });

    const claim = await fixture.runtime.authorizeExecution({
      requestId: record.request.requestId, executionId: "exec-1",
      nonce: record.request.nonce, agentSessionId: "session-2",
    });
    expect(claim).toEqual({ ok: false, reason: "agent-session-mismatch" });
  });

  it("过期拒绝：pending 超时后 approve 拒绝且状态 expired（RT-03-A）", async () => {
    const fixture = makeFixture();
    const { record } = await makeWriteRequest(fixture, { ttlMs: 60_000 });

    fixture.tick(2 * 60_000);
    const approve = await fixture.runtime.approve({ requestId: record.request.requestId, by: { principalId: "local" } });
    expect(approve).toEqual({ ok: false, reason: "expired" });

    const current = await fixture.runtime.authorizeExecution({
      requestId: record.request.requestId, executionId: "exec-1", nonce: record.request.nonce,
    });
    expect(current).toEqual({ ok: false, reason: "not-approved:expired" });
  });

  it("参数变化拒绝：执行时的实际参数与请求摘要不一致（RT-03-A）", async () => {
    const fixture = makeFixture();
    const { record } = await makeWriteRequest(fixture);
    await fixture.runtime.approve({ requestId: record.request.requestId, by: { principalId: "local" } });

    const changed = await fixture.runtime.authorizeExecution({
      requestId: record.request.requestId, executionId: "exec-1", nonce: record.request.nonce,
      params: { files: ["src/a.ts", "src/b.ts"] },
    });
    expect(changed).toEqual({ ok: false, reason: "params-changed" });

    const unchanged = await fixture.runtime.authorizeExecution({
      requestId: record.request.requestId, executionId: "exec-1", nonce: record.request.nonce,
      params: { files: ["src/a.ts"] },
    });
    expect(unchanged.ok).toBe(true);
  });

  it("approve/cancel 竞争只有一个终态；撤销在批准后重新检查（RT-03-B）", async () => {
    const fixture = makeFixture();
    const { record } = await makeWriteRequest(fixture);
    const requestId = record.request.requestId;

    // 先取消后批准：批准失败（cancelled 是终态）。
    await fixture.runtime.cancel({ requestId, by: { principalId: "local" } });
    const lateApprove = await fixture.runtime.approve({ requestId, by: { principalId: "local" } });
    expect(lateApprove).toEqual({ ok: false, reason: "not-pending:cancelled" });

    // 批准后撤销：决定不回滚，但执行认领被拒（重新检查生效）。
    const second = await makeWriteRequest(fixture);
    await fixture.runtime.approve({ requestId: second.record.request.requestId, by: { principalId: "local" } });
    const cancelResult = await fixture.runtime.requestCancelAfterApproval(second.record.request.requestId);
    expect(cancelResult.ok).toBe(true);
    const denied = await fixture.runtime.authorizeExecution({
      requestId: second.record.request.requestId, executionId: "exec-1", nonce: second.record.request.nonce,
    });
    expect(denied).toEqual({ ok: false, reason: "cancel-requested" });

    // 已认领后收到撤销：副作用不可追回，如实标记 cancelRequested。
    const third = await makeWriteRequest(fixture);
    await fixture.runtime.approve({ requestId: third.record.request.requestId, by: { principalId: "local" } });
    const claimed = await fixture.runtime.authorizeExecution({ requestId: third.record.request.requestId, executionId: "exec-1", nonce: third.record.request.nonce });
    expect(claimed.ok).toBe(true);
    const late = await fixture.runtime.requestCancelAfterApproval(third.record.request.requestId);
    expect(late.note).toContain("cancel-requested-cannot-revert");
  });

  it("重启不自动批准：pending 持久化后新实例里仍是 pending（RT-03-B）", async () => {
    const fixture = makeFixture();
    const { record } = await makeWriteRequest(fixture);

    const reborn = makeFixture();
    reborn.settings.clear();
    for (const [key, value] of fixture.settings) reborn.settings.set(key, value);
    // fixture 时钟对齐。
    reborn.tick(BASE - reborn.now);

    const current = await reborn.runtime.authorizeExecution({
      requestId: record.request.requestId, executionId: "exec-1", nonce: record.request.nonce,
    });
    // 没有任何批准动作发生：执行必须被拒。
    expect(current).toEqual({ ok: false, reason: "not-approved:pending" });
  });

  it("无策略能力时 fail-closed：全部拒绝而非放行（RT-03-C）", async () => {
    const fixture = makeFixture(createDenyAllPolicy());
    const result = await fixture.runtime.request({
      principalId: "local", conversationId: "local",
      category: "read", kind: "file.read", workspace: WS, targetPath: "src/x.ts",
    });
    expect(result).toEqual({ ok: false, reason: "policy-denied" });

    // 连批准能力也被收回：就算有条记录也批不了。
    await expect(fixture.runtime.approve({ requestId: "anything", by: { principalId: "local" } })).resolves.toMatchObject({ ok: false });
  });

  it("审计脱敏：只有摘要没有原始参数（RT-03-C）", async () => {
    const fixture = makeFixture();
    const { record } = await makeWriteRequest(fixture);
    await fixture.runtime.approve({ requestId: record.request.requestId, by: { principalId: "local" } });
    await fixture.runtime.authorizeExecution({
      requestId: record.request.requestId, executionId: "exec-1", nonce: record.request.nonce,
      params: { files: ["src/a.ts"] },
    });

    // 审计对象不在公开 API 上——用存储文档核实：整份持久化里没有原始参数文本。
    const dump = JSON.stringify([...fixture.settings.values()]);
    expect(dump).not.toContain("src/a.ts");
    // 摘要在：请求记录带 digest。
    expect(dump).toContain("paramsDigest");
  });

  it("群聊不能批准高权限动作；本地主体批自己会话的请求可以（RT-03-D）", async () => {
    const fixture = makeFixture();
    const { record } = await makeWriteRequest(fixture);

    const groupApprove = await fixture.runtime.approve({
      requestId: record.request.requestId, by: { principalId: "local", isGroupConversation: true },
    });
    expect(groupApprove).toEqual({ ok: false, reason: "approver-not-authorized" });

    const directApprove = await fixture.runtime.approve({
      requestId: record.request.requestId, by: { principalId: "local" },
    });
    expect(directApprove.ok).toBe(true);
  });

  it("危险动作默认拒绝，没有 approve-all（RT-03-D）", async () => {
    const fixture = makeFixture();
    for (const kind of ["payment", "billing.charge", "account.delete", "credential.store"]) {
      const result = await fixture.runtime.request({
        principalId: "local", conversationId: "local",
        category: "external", kind, params: { amount: 1 },
      });
      expect(result).toEqual({ ok: false, reason: "policy-denied" });
    }
    // unknown 主体请求直接拒绝。
    const unknown = await fixture.runtime.request({
      principalId: "unknown", conversationId: "local",
      category: "read", kind: "file.read", workspace: WS, targetPath: "x",
    });
    expect(unknown).toEqual({ ok: false, reason: "unknown-principal" });
  });

  it("路径越界请求直接拒绝（RT-03-D）", async () => {
    const fixture = makeFixture();
    const escape = await fixture.runtime.request({
      principalId: "local", conversationId: "local",
      category: "write", kind: "file.write",
      workspace: WS, targetPath: "..\\outside.txt",
    });
    expect(escape).toEqual({ ok: false, reason: "path-escape" });
  });

  it("nonce 单次绑定：错 nonce 认领拒绝（RT-03-A）", async () => {
    const fixture = makeFixture();
    const { record } = await makeWriteRequest(fixture);
    await fixture.runtime.approve({ requestId: record.request.requestId, by: { principalId: "local" } });
    const claim = await fixture.runtime.authorizeExecution({
      requestId: record.request.requestId, executionId: "exec-1", nonce: "wrong",
    });
    expect(claim).toEqual({ ok: false, reason: "nonce-mismatch" });
  });
});
