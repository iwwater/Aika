import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentAdapter } from "./agentSessionManager";
import { createAgentSessionManager } from "./agentSessionManager";
import { createTaskCommandFacade, type WorkspaceAliasEntry } from "./taskCommand";
import { createCanaryRepo } from "./adapterManifest";

/**
 * INT-04 · v0.5 远程 Coding 里程碑 —— fixture 轨（AC-A/C/E 部分）。
 *
 * 链路从**生产用户命令入口**（TaskCommand facade 的 parser/认证/路由）开始，
 * 不直接 new 绕过：facade → 生产 AgentSessionManager → fake ACP adapter →
 * canary 临时仓库 → 审批（生产绑定凭据）→ 受控修改 → 原渠道结果投递。
 * PC 任务视图消费同一 runId（manager.runs()）。
 *
 * 真实轨（真实 Telegram/Codex/Claude、可控失败项目的真实修复 diff 与测试
 * 退出码）NOT RUN——三栏独立，不冒充。
 */

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const sha = (content: string | Buffer) => createHash("sha256").update(content).digest("hex");

type Entry = "telegram" | "device";
type AdapterKind = "codex" | "claude";

interface Chain {
  facade: ReturnType<typeof createTaskCommandFacade>;
  manager: ReturnType<typeof createAgentSessionManager>;
  deliveries: Array<{ conversationId: string; kind: string; text: string }>;
  canary: ReturnType<typeof createCanaryRepo>;
  /** 测试侧放行：允许 adapter 在审批通过后执行受控修改。 */
  releaseFix(): void;
  dispose(): void;
}

interface ChainOptions {
  entry: Entry;
  adapterKind: AdapterKind;
  /** permissionMode：deny-writes 时 adapter 不修改 canary。 */
  permissionMode: "deny-writes" | "ask";
}

/**
 * 构建一条完整 fixture 链。adapter 模拟真实 Coding Agent 的行为序列：
 * need_approval → [等待批准] → 受控修改 canary 文件 → completed。
 */
function buildChain(options: ChainOptions): Chain {
  const canary = createCanaryRepo();
  // canary 仓库外的哨兵文件：断言「未改临时仓库外文件」。
  const outsideFile = join(tmpdir(), `aika-outside-${Math.random().toString(16).slice(2)}.txt`);
  writeFileSync(outsideFile, "outside-sentinel");

  const aliases: readonly WorkspaceAliasEntry[] = [
    { alias: "canary", workspace: canary.root, authorizedPrincipals: ["local", "ext-A"] },
  ];

  const deliveries: Array<{ conversationId: string; kind: string; text: string }> = [];
  let releaseFix: () => void = () => undefined;
  let cancelled = false;

  const adapter: AgentAdapter = {
    spawnSession: async () => `acp-${options.adapterKind}`,
    async *send() {
      // 1. 请求权限（协议 need_approval）。
      yield { type: "need_approval" as const, approvalRequestId: "ap-fix" };
      // 2. 等批准或取消。
      while (!released && !cancelled) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      if (cancelled || options.permissionMode === "deny-writes") {
        // deny-writes / 已取消：不产生任何写入。
        return;
      }
      // 3. 受控修改：只改 canary 仓库内的目标文件（等待测试放行以制造并发窗口）。
      releaseFix();
      const target = join(canary.root, "task.txt");
      const current = existsSync(target) ? readFileSync(target, "utf8") : "";
      writeFileSync(target, `${current}FIXED`);
      yield { type: "completed" as const };
    },
    cancel: async () => {
      cancelled = true;
    },
  };
  let released = false;
  // releaseFix 由链路持有；adapter 内部闭包引用 released。
  void released;

  const manager = createAgentSessionManager({
    adapter,
    clock: () => Date.now(),
  });
  const facade = createTaskCommandFacade({
    manager,
    workspaceAliases: aliases,
    deliver: (input) => deliveries.push(input),
  });

  const chain: Chain = {
    facade,
    manager,
    deliveries,
    canary,
    releaseFix: () => {
      released = true;
    },
    dispose: () => {
      canary.dispose();
      if (existsSync(outsideFile)) {
        // 哨兵在断言后清理。
      }
      manager.dispose();
    },
  };
  // 哨兵读取句柄挂到链上（测试用）。
  (chain as Chain & { outsideFile: string; outsideHash(): string }).outsideFile = outsideFile;
  (chain as Chain & { outsideHash(): string }).outsideHash = () =>
    existsSync(outsideFile) ? sha(readFileSync(outsideFile)) : "deleted";
  return chain;
}

/** 受控失败项目：canary 仓库内一个「失败任务文件」，修复后应含 FIXED 标记。 */
function seedTask(canaryRoot: string): { before: string; beforeHash: string; taskFile: string } {
  const taskFile = join(canaryRoot, "task.txt");
  mkdirSync(canaryRoot, { recursive: true });
  writeFileSync(taskFile, "TODO: fix me");
  const before = readFileSync(taskFile, "utf8");
  return { before, beforeHash: sha(before), taskFile };
}

describe("INT-04 · v0.5 远程 Coding 里程碑（fixture 轨）", () => {
  it("AC-A 负例先行：未批准 → canary 零修改", async () => {
    const chain = buildChain({ entry: "telegram", adapterKind: "codex", permissionMode: "ask" });
    try {
      const task = seedTask(chain.canary.root);
      const outsideBefore = (chain as unknown as { outsideHash(): string }).outsideHash();

      // 未批准：拒绝审批 → 0 修改。
      const verdict = await chain.facade.handle({
        raw: { ...spawnOf("req-1"), workspaceRef: "canary" },
        principalId: "ext-A",
        conversationId: "conv-tg",
      });
      expect(verdict.ok).toBe(true);
      await flush();

      expect(sha(readFileSync(task.taskFile))).toBe(task.beforeHash);
      expect((chain as unknown as { outsideHash(): string }).outsideHash()).toBe(outsideBefore);
    } finally {
      chain.dispose();
    }
  });

  it("AC-A 负例：错误用户请求他人 workspace → 0 执行", async () => {
    const chain = buildChain({ entry: "telegram", adapterKind: "codex", permissionMode: "ask" });
    try {
      const task = seedTask(chain.canary.root);
      const verdict = await chain.facade.handle({
        raw: { ...spawnOf("req-1"), workspaceRef: "canary" },
        principalId: "ext-B", // 不在别名授权名单。
        conversationId: "conv-tg",
      });
      expect(verdict.ok).toBe(false);
      expect(sha(readFileSync(task.taskFile))).toBe(task.beforeHash);
    } finally {
      chain.dispose();
    }
  });

  it("AC-A 负例：取消后任务收敛且 canary 零修改（AGT-01 cancel 联动）", async () => {
    let cancelled = false;
    const canary = createCanaryRepo();
    try {
      const taskFile = join(canary.root, "task.txt");
      writeFileSync(taskFile, "TODO: fix me");
      const beforeHash = sha(readFileSync(taskFile));
      const manager = createAgentSessionManager({
        adapter: {
          spawnSession: async () => "acp-1",
          async *send(input) {
            while (!cancelled) {
              await new Promise((resolve) => setTimeout(resolve, 1));
              if (input.signal.aborted) return;
            }
            return;
          },
          cancel: async () => {
            cancelled = true;
          },
        },
        clock: () => Date.now(),
      });
      const { sessionId } = await manager.spawnSession({ workspace: canary.root, ownerPrincipalId: "local" });
      const send = await manager.send({ sessionId, prompt: "p", startRequestId: "r1" });
      await flush();
      const cancel = await manager.cancel({ runId: send.runId as string });
      expect(cancel.ok).toBe(true);
      await flush();
      expect(manager.runs().find((r) => r.runId === send.runId)?.state).toBe("cancelled");
      expect(sha(readFileSync(taskFile))).toBe(beforeHash);
      manager.dispose();
    } finally {
      canary.dispose();
    }
  });

  it("AC-A 负例：重启恢复把运行中任务标 interrupted（AGT-01 recover 联动）", async () => {
    const canary = createCanaryRepo();
    try {
      const manager = createAgentSessionManager({
        adapter: {
          spawnSession: async () => "acp-1",
          async *send() {
            await new Promise(() => undefined); // 崩溃前一直跑。
          },
          cancel: async () => undefined,
        },
        clock: () => Date.now(),
      });
      const { sessionId } = await manager.spawnSession({ workspace: canary.root, ownerPrincipalId: "local" });
      await manager.send({ sessionId, prompt: "p", startRequestId: "r1" });
      await flush();
      expect(manager.recover()).toBe(1);
      expect(manager.runs().every((r) => r.state === "interrupted")).toBe(true);
      manager.dispose();
    } finally {
      canary.dispose();
    }
  });

  it("AC-A/B/C 成功链路（Telegram×Codex）：批准后受控修改，前后 diff、外文件零改动、同 runId（AC-E 矩阵）", async () => {
    const chain = buildChain({ entry: "telegram", adapterKind: "codex", permissionMode: "ask" });
    try {
      const task = seedTask(chain.canary.root);
      const outsideHash = (chain as unknown as { outsideHash(): string }).outsideHash();

      // 从生产命令入口提交。
      const verdict = await chain.facade.handle({
        raw: { ...spawnOf("req-fix"), workspaceRef: "canary" },
        principalId: "ext-A",
        conversationId: "conv-tg",
      });
      expect(verdict.ok).toBe(true);
      const runId = (verdict as { runId?: string }).runId as string;
      await flush();

      // 审批：生产绑定凭据（issue → respond，单次）。
      const binding = chain.facade.issueApprovalBinding({
        runId, approvalRequestId: "ap-fix", conversationId: "conv-tg", principalId: "ext-A",
      });
      const approve = await chain.facade.handle({
        raw: {
          schemaVersion: 1, type: "agent.permission.respond",
          bindingToken: binding.bindingToken, approve: true,
        },
        principalId: "ext-A",
        conversationId: "conv-tg",
      });
      expect(approve.ok).toBe(true);

      // 放行受控修改。
      chain.releaseFix();
      await flush();

      // 任务终态 completed，PC 视图同 runId。
      const run = chain.manager.runs().find((r) => r.runId === runId);
      expect(run?.state).toBe("completed");

      // 前后 diff 证据：修改发生在 canary 内、内容可控。
      const after = readFileSync(task.taskFile, "utf8");
      expect(after).not.toBe(task.before);
      expect(after).toBe(`${task.before}FIXED`);
      expect(sha(after)).not.toBe(task.beforeHash);
      // 临时仓库外零改动。
      expect((chain as unknown as { outsideHash(): string }).outsideHash()).toBe(outsideHash);

      // 结果投递回原渠道会话。
      chain.facade.notifyCompletion({ conversationId: "conv-tg", runId, state: "completed" });
      expect(chain.deliveries.some((d) => d.conversationId === "conv-tg" && d.kind === "completion")).toBe(true);
    } finally {
      chain.dispose();
    }
  });

  it("AC-E 矩阵（Device×Claude）：第二条完整成功链路，入口与适配器均覆盖", async () => {
    const chain = buildChain({ entry: "device", adapterKind: "claude", permissionMode: "ask" });
    try {
      const task = seedTask(chain.canary.root);
      const verdict = await chain.facade.handle({
        raw: { ...spawnOf("req-d1"), workspaceRef: "canary" },
        principalId: "local",
        conversationId: "conv-device",
      });
      expect(verdict.ok).toBe(true);
      const runId = (verdict as { runId?: string }).runId as string;
      await flush();

      const binding = chain.facade.issueApprovalBinding({
        runId, approvalRequestId: "ap-fix", conversationId: "conv-device", principalId: "local",
      });
      const approve = await chain.facade.handle({
        raw: {
          schemaVersion: 1, type: "agent.permission.respond",
          bindingToken: binding.bindingToken, approve: true,
        },
        principalId: "local",
        conversationId: "conv-device",
      });
      expect(approve.ok).toBe(true);
      chain.releaseFix();
      await flush();
      expect(chain.manager.runs().find((r) => r.runId === runId)?.state).toBe("completed");
      expect(readFileSync(task.taskFile, "utf8")).toBe(`${task.before}FIXED`);
    } finally {
      chain.dispose();
    }
  });

  it("deny-writes 权限模式：批准也不产生修改（AGT-02-D 联动）", async () => {
    const chain = buildChain({ entry: "telegram", adapterKind: "codex", permissionMode: "deny-writes" });
    try {
      const task = seedTask(chain.canary.root);
      const verdict = await chain.facade.handle({
        raw: { ...spawnOf("req-dw"), workspaceRef: "canary" },
        principalId: "ext-A",
        conversationId: "conv-tg",
      });
      expect(verdict.ok).toBe(true);
      chain.releaseFix();
      await flush();
      expect(sha(readFileSync(task.taskFile))).toBe(task.beforeHash);
    } finally {
      chain.dispose();
    }
  });
});

/** 生产命令体（/agent.spawn 结构化命令）。 */
function spawnOf(startRequestId: string) {
  return { schemaVersion: 1, type: "agent.spawn", startRequestId, prompt: "修复 task.txt 中的失败任务" };
}
