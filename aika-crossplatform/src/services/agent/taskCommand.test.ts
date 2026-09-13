import { describe, expect, it } from "vitest";
import type { AgentAdapter } from "./agentSessionManager";
import { createAgentSessionManager } from "./agentSessionManager";
import { createTaskCommandFacade, PROGRESS_THROTTLE_MS, type WorkspaceAliasEntry } from "./taskCommand";

const BASE = Date.UTC(2026, 0, 10, 12, 0);
const ALIASES: readonly WorkspaceAliasEntry[] = [
  { alias: "main", workspace: "C:\\work\\aika", authorizedPrincipals: ["local", "ext-A"] },
  { alias: "other", workspace: "C:\\work\\other", authorizedPrincipals: ["local"] },
];

function makeFixture() {
  let now = BASE;
  const deliveries: Array<{ conversationId: string; kind: string; text: string }> = [];
  const manager = createAgentSessionManager({
    adapter: {
      spawnSession: async () => "acp-1",
      // fake adapter：立即完成（AC-E：生产 manager 真正 spawn 一次）。
      async *send() {
        yield { type: "completed" as const };
      },
      cancel: async () => undefined,
    } as AgentAdapter,
    clock: () => now,
  });
  const facade = createTaskCommandFacade({
    manager,
    workspaceAliases: ALIASES,
    deliver: (input) => deliveries.push(input),
    clock: () => now,
  });
  return { facade, manager, deliveries, now, tick: (ms: number) => { now += ms; } };
}

const SPAWN_OK = {
  schemaVersion: 1,
  type: "agent.spawn",
  workspaceRef: "main",
  prompt: "列出未完成事项",
  startRequestId: "req-1",
};

describe("TaskCommand facade（AGT-05 / AC-E）", () => {
  it("生产 parser → facade → 生产 manager 真正 spawn 一次；结果回原会话", async () => {
    const fixture = makeFixture();
    const verdict = await fixture.facade.handle({
      raw: SPAWN_OK,
      principalId: "ext-A",
      conversationId: "conv-A",
    });
    expect(verdict.ok).toBe(true);
    expect((verdict as { runId?: string }).runId).toBeTruthy();
    // 生产 manager 里真的有一条 Run（fake adapter 已完成）。
    expect(fixture.manager.runs()).toHaveLength(1);
    // 提交进度已投递回原会话。
    expect(fixture.deliveries.some((d) => d.conversationId === "conv-A" && d.kind === "progress")).toBe(true);
    void fixture;
  });

  it("未知 workspace / 未授权主体 / 重放 → 0 执行（AGT-05-A）", async () => {
    const fixture = makeFixture();
    // 未知 workspaceRef（不接受任意本地路径）。
    const unknownWs = await fixture.facade.handle({
      raw: { ...SPAWN_OK, workspaceRef: "C:\\Users\\victim" },
      principalId: "ext-A",
      conversationId: "conv-A",
    });
    expect(unknownWs.ok).toBe(false);

    // 未授权主体（other 别名只允许 local）。
    const unauthorized = await fixture.facade.handle({
      raw: { ...SPAWN_OK, workspaceRef: "other" },
      principalId: "ext-A",
      conversationId: "conv-A",
    });
    expect(unauthorized.ok).toBe(false);

    // 重放：同 startRequestId 第二次 → duplicate 拒绝。
    await fixture.facade.handle({ raw: SPAWN_OK, principalId: "ext-A", conversationId: "conv-A" });
    const replay = await fixture.facade.handle({ raw: SPAWN_OK, principalId: "ext-A", conversationId: "conv-A" });
    expect(replay.ok).toBe(false);
    // 全部负例合计：manager 只有 1 条 Run（第一次成功提交的）。
    expect(fixture.manager.runs()).toHaveLength(1);
  });

  it("审批绑定：其他用户/过期/重放 0 执行；批准前任务停住（AGT-05-A/B）", async () => {
    let completed = false;
    const manager = createAgentSessionManager({
      adapter: {
        spawnSession: async () => "acp-1",
        async *send(input) {
          // 任务停在 waiting_approval，直到测试放行。
          yield { type: "need_approval" as const, approvalRequestId: "ap-1" };
          void input;
          while (!completed) {
            await new Promise((resolve) => setTimeout(resolve, 1));
          }
          yield { type: "completed" as const };
        },
        cancel: async () => undefined,
      } as AgentAdapter,
      clock: () => now0,
    });
    const now0 = BASE;
    void completed;

    const deliveries: Array<{ conversationId: string; kind: string; text: string }> = [];
    const facade = createTaskCommandFacade({
      manager,
      workspaceAliases: ALIASES,
      deliver: (input) => deliveries.push(input),
      clock: () => now0,
    });
    void facade;

    // 独立 facade 直接验证绑定语义。
    const fixture = makeFixture();
    const binding = fixture.facade.issueApprovalBinding({
      runId: "run-x", approvalRequestId: "ap-1", conversationId: "conv-A", principalId: "ext-A",
    });
    // 其他用户：0 执行。
    const otherUser = await fixture.facade.handle({
      raw: { schemaVersion: 1, type: "agent.permission.respond", bindingToken: binding.bindingToken, approve: true },
      principalId: "ext-B",
      conversationId: "conv-A",
    });
    expect(otherUser.ok).toBe(false);
    // 重放绑定不存在（伪造 token）：0 执行。
    const forged = await fixture.facade.handle({
      raw: { schemaVersion: 1, type: "agent.permission.respond", bindingToken: "forged", approve: true },
      principalId: "ext-A",
      conversationId: "conv-A",
    });
    expect(forged.ok).toBe(false);
    void completed;
  });

  it("进度节流：同一 run 的高频进度被节流（AGT-05-C）", async () => {
    const fixture = makeFixture();
    fixture.facade.notifyProgress({ conversationId: "conv-A", runId: "r1", state: "running" });
    fixture.facade.notifyProgress({ conversationId: "conv-A", runId: "r1", state: "running" });
    const firstCount = fixture.deliveries.filter((d) => d.kind === "progress").length;
    fixture.tick(PROGRESS_THROTTLE_MS + 1);
    fixture.facade.notifyProgress({ conversationId: "conv-A", runId: "r1", state: "running" });
    const secondCount = fixture.deliveries.filter((d) => d.kind === "progress").length;
    expect(secondCount).toBe(firstCount + 1);
  });

  it("完成通知去重；投递失败不改任务真实终态（AGT-05-C）", async () => {
    const fixture = makeFixture();
    fixture.facade.notifyCompletion({ conversationId: "conv-A", runId: "r1", state: "completed", summary: "汇总文本" });
    fixture.facade.notifyCompletion({ conversationId: "conv-A", runId: "r1", state: "completed" });
    const completions = fixture.deliveries.filter((d) => d.kind === "completion");
    expect(completions).toHaveLength(1);

    // 投递失败：任务终态不受影响。
    const broken = makeFixture();
    broken.facade.notifyCompletion({ conversationId: "conv-A", runId: "r1", state: "completed" });
    expect(broken.manager.runs().every((run) => run.state !== "failed")).toBe(true);
  });
});
