/**
 * TaskCommand facade 与远程审批/进度/结果投递（AGT-05）。
 *
 * 用户发起入口：远程私聊用显式 /agent 结构化命令（body 不接受任意本地路径，
 * 只传服务端白名单 workspaceRef）；桌面任务面板与远程 session 引用**同一
 * runId**，禁止第二任务状态。
 *
 * 审批卡三要素：只引用服务端请求；按钮带**单次绑定凭据**；目标为已验证
 * 私聊/设备。其他用户/群/过期按钮/重放 → 0 执行。
 *
 * 结果是不可信资料：Aika 汇总失败不改任务真实终态；进度节流、完成通知去重、
 * 发送失败旁路化。
 */

import { paramsDigestOf } from "../../domain/permission";
import type { AgentSessionManager } from "./agentSessionManager";

export const TASK_COMMAND_SCHEMA_VERSION = 1;
/** 审批绑定凭据有效期。 */
export const APPROVAL_BINDING_TTL_MS = 10 * 60_000;
/** 进度通知最小间隔。 */
export const PROGRESS_THROTTLE_MS = 5_000;

export interface WorkspaceAliasEntry {
  alias: string;
  workspace: string;
  /** 允许通过该别名提交的主体。 */
  authorizedPrincipals: readonly string[];
}

export interface TaskCommandFacadeOptions {
  manager: AgentSessionManager;
  /** 服务端 workspaceRef 白名单：alias → 规范化 workspace + 授权主体。 */
  workspaceAliases: readonly WorkspaceAliasEntry[];
  /** 投递端口（通知/结果发回原会话；发送失败旁路化）。 */
  deliver: (input: { conversationId: string; text: string; kind: "progress" | "completion" | "rejection" | "result" }) => void;
  clock?: () => number;
  idFactory?: () => string;
}

export type TaskCommandVerdict =
  | { ok: true; kind: "spawn" | "send" | "cancel" | "approval"; runId?: string; sessionId?: string; note?: string }
  | { ok: false; reason: string };

interface ApprovalBinding {
  approvalRequestId: string;
  runId: string;
  conversationId: string;
  principalId: string;
  expiresAt: number;
  consumed: boolean;
}

export interface TaskCommandFacade {
  /** 生产命令入口：raw（/agent 结构化命令）→ 校验 → 生产 manager。 */
  handle(input: { raw: unknown; principalId: string; conversationId: string }): Promise<TaskCommandVerdict>;
  /** 生成审批卡的单次绑定凭据（服务端持有，按 runId+requestId 绑定）。 */
  issueApprovalBinding(input: { runId: string; approvalRequestId: string; conversationId: string; principalId: string }): { bindingToken: string; expiresAt: number };
  /** 进度节流投递。 */
  notifyProgress(input: { conversationId: string; runId: string; state: string }): void;
  /** 完成通知（按 runId+终态去重；投递失败不改任务真实终态）。 */
  notifyCompletion(input: { conversationId: string; runId: string; state: string; summary?: string }): void;
  /** 任务面板/远程 session 共用的任务记录读取（同 runId，无第二状态）。 */
  runs(): Array<{ runId: string; sessionId: string; state: string }>;
}

export function createTaskCommandFacade(options: TaskCommandFacadeOptions): TaskCommandFacade {
  const clock = options.clock ?? (() => Date.now());
  const idFactory = options.idFactory ?? defaultIdFactory;
  const aliases = new Map(options.workspaceAliases.map((entry) => [entry.alias, entry]));
  const approvalBindings = new Map<string, ApprovalBinding>();
  const completionNotified = new Set<string>();
  /** spawn 重放去重：主体+会话+startRequestId。 */
  const spawnDedupe = new Set<string>();
  const lastProgressAt = new Map<string, number>();

  function deliverSafe(input: { conversationId: string; text: string; kind: "progress" | "completion" | "rejection" | "result" }): void {
    try {
      options.deliver(input);
    } catch {
      // 发送失败不改任务真实终态（AGT-05-C）。
    }
  }

  function reject(conversationId: string, reason: string): TaskCommandVerdict {
    deliverSafe({ conversationId, text: `命令被拒绝：${reason}`, kind: "rejection" });
    return { ok: false, reason };
  }

  return {
    async handle(input) {
      const body = input.raw as Record<string, unknown> | null;
      if (!body || typeof body !== "object" || body.schemaVersion !== TASK_COMMAND_SCHEMA_VERSION) {
        return reject(input.conversationId, "unsupported-schema");
      }
      const type = body.type as string;
      const principalId = input.principalId?.trim() || "unknown";

      if (type === "agent.spawn") {
        const workspaceRef = String(body.workspaceRef ?? "");
        const alias = aliases.get(workspaceRef);
        if (!alias) {
          // 未知 workspace / 任意本地路径：0 执行。
          return reject(input.conversationId, "unknown-workspace");
        }
        if (!alias.authorizedPrincipals.includes(principalId)) {
          return reject(input.conversationId, "unauthorized-principal");
        }
        const prompt = String(body.prompt ?? "");
        const startRequestId = String(body.startRequestId ?? "");
        if (!prompt.trim() || !startRequestId.trim()) {
          return reject(input.conversationId, "empty-prompt-or-request-id");
        }
        const spawnDedupeKey = `${principalId}:${input.conversationId}:${startRequestId}`;
        if (spawnDedupe.has(spawnDedupeKey)) {
          return reject(input.conversationId, "duplicate");
        }
        spawnDedupe.add(spawnDedupeKey);
        const spawn = await options.manager.spawnSession({ workspace: alias.workspace, ownerPrincipalId: principalId });
        const sent = await options.manager.send({ sessionId: spawn.sessionId, prompt, startRequestId });
        if (!sent.ok) {
          return reject(input.conversationId, sent.reason ?? "send-failed");
        }
        deliverSafe({
          conversationId: input.conversationId,
          text: `任务已提交：run ${sent.runId}`,
          kind: "progress",
        });
        return { ok: true, kind: "spawn", runId: sent.runId, sessionId: spawn.sessionId };
      }

      if (type === "agent.send") {
        const runId = String(body.runId ?? "");
        const run = options.manager.runs().find((task) => task.runId === runId);
        if (!run) return reject(input.conversationId, "unknown-run");
        const sent = await options.manager.send({ sessionId: run.sessionId, prompt: String(body.text ?? ""), startRequestId: `${runId}:send:${clock()}` });
        if (!sent.ok) return reject(input.conversationId, sent.reason ?? "send-failed");
        return { ok: true, kind: "send", runId: sent.runId };
      }

      if (type === "agent.cancel") {
        const runId = String(body.runId ?? "");
        const run = options.manager.runs().find((task) => task.runId === runId);
        if (!run) return reject(input.conversationId, "unknown-run");
        await options.manager.cancel({ runId });
        return { ok: true, kind: "cancel", runId };
      }

      if (type === "agent.permission.respond") {
        const bindingToken = String(body.bindingToken ?? "");
        const binding = approvalBindings.get(bindingToken);
        if (!binding || binding.consumed) {
          // 重放/伪造凭据：0 执行。
          return reject(input.conversationId, "invalid-approval-binding");
        }
        if (clock() > binding.expiresAt) {
          return reject(input.conversationId, "approval-expired");
        }
        // 其他用户/群：绑定凭据 + 目标身份双重绑定。
        if (binding.principalId !== principalId || binding.conversationId !== input.conversationId) {
          return reject(input.conversationId, "binding-mismatch");
        }
        const approve = body.approve === true;
        const resolved = options.manager.resolveApproval({
          runId: binding.runId,
          approvalRequestId: binding.approvalRequestId,
          approve,
        });
        if (!resolved.ok) return reject(input.conversationId, "not-waiting-approval");
        // 单次绑定：消费。
        binding.consumed = true;
        return { ok: true, kind: "approval", runId: binding.runId };
      }

      return reject(input.conversationId, "unsupported-type");
    },

    issueApprovalBinding(input) {
      const bindingToken = idFactory();
      const expiresAt = clock() + APPROVAL_BINDING_TTL_MS;
      approvalBindings.set(bindingToken, {
        approvalRequestId: input.approvalRequestId,
        runId: input.runId,
        conversationId: input.conversationId,
        principalId: input.principalId,
        expiresAt,
        consumed: false,
      });
      return { bindingToken, expiresAt };
    },

    notifyProgress(input) {
      const key = `${input.conversationId}:${input.runId}`;
      const last = lastProgressAt.get(key) ?? 0;
      if (clock() - last < PROGRESS_THROTTLE_MS) return; // 节流。
      lastProgressAt.set(key, clock());
      deliverSafe({ conversationId: input.conversationId, text: `[${input.runId}] ${input.state}`, kind: "progress" });
    },

    notifyCompletion(input) {
      const key = `${input.conversationId}:${input.runId}:${input.state}`;
      if (completionNotified.has(key)) return; // 完成通知去重。
      completionNotified.add(key);
      // 结果是不可信资料：Aika 汇总失败不改任务真实终态——summary 只是附加文本。
      const suffix = input.summary ? `\n汇总：${input.summary}` : "";
      deliverSafe({
        conversationId: input.conversationId,
        text: `任务 ${input.runId} 终态：${input.state}${suffix}`,
        kind: "completion",
      });
    },

    runs: () => options.manager.runs().map((run) => ({ runId: run.runId, sessionId: run.sessionId, state: run.state })),
  };
}

/** prompt 摘要（审计用）。 */
export function taskPromptDigest(prompt: string): string {
  return paramsDigestOf(prompt);
}

function defaultIdFactory(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `task-${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`;
}
