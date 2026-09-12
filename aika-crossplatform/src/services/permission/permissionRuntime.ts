/**
 * Permission Runtime（RT-03）。
 *
 * 决策与执行是两个阶段：审批给出的是**决定**（approved 是决定终态）；真正执行
 * 前还要 `authorizeExecution` 做**最后的授权检查**并原子认领恰好一次——
 * 重放、跨用户、跨会话、过期、参数变化在这一步全部被拒。
 *
 * 审计只记：谁、何时、对哪个请求、做了什么决定、参数摘要。原始参数与正文
 * 永远不进审计（脱敏不是过滤，是根本没有字段）。
 */

import {
  checkPathBoundary, paramsDigestOf,
  MAX_PERMISSION_TTL_MS, PERMISSION_POLICY_VERSION, PERMISSION_SCHEMA_VERSION,
  type PermissionCategory, type PermissionRecordV1,
  type PermissionRequestV1, type PermissionState,
} from "../../domain/permission";
import type { PermissionPolicy } from "./permissionPolicy";
import type { PermissionStore } from "./permissionStore";

export interface RequestPermissionInput {
  principalId: string;
  conversationId: string;
  agentSessionId?: string;
  category: PermissionCategory;
  kind: string;
  /** 原始动作参数；只留摘要进请求，绝不落原文。 */
  params?: unknown;
  /** workspace 绝对路径；路径类动作必填，越界直接拒绝。 */
  workspace?: string;
  /** 目标路径（绝对或相对 workspace）。 */
  targetPath?: string;
  /** 真实路径解析（junction/reparse/TOCTOU 防线）；不提供则词法判定并标记 assumedLexical。 */
  realPathOf?: (absolute: string) => string | null;
  ttlMs?: number;
  now?: number;
}

export type RequestPermissionResult =
  | { ok: true; record: PermissionRecordV1; autoAllowed: boolean }
  | { ok: false; reason: string };

export interface DecisionInput {
  requestId: string;
  by: { principalId: string; isGroupConversation?: boolean };
  at?: number;
}

export type DecisionResult =
  | { ok: true; record: PermissionRecordV1 }
  | { ok: false; reason: string };

export interface ClaimExecutionInput {
  requestId: string;
  executionId: string;
  /** 执行前的最终参数：摘要必须与请求一致（参数变化拒绝）。 */
  params?: unknown;
  byPrincipalId?: string;
  agentSessionId?: string;
  nonce?: string;
  at?: number;
}

export type ClaimExecutionResult =
  | { ok: true; record: PermissionRecordV1; /** true = 只做了词法边界检查，真实路径未验证。 */ assumedLexical?: boolean }
  | { ok: false; reason: string };

export interface PermissionRuntime {
  request(input: RequestPermissionInput): Promise<RequestPermissionResult>;
  approve(input: DecisionInput): Promise<DecisionResult>;
  reject(input: DecisionInput): Promise<DecisionResult>;
  /** pending 阶段的撤销；approved 之后走 requestCancelAfterApproval。 */
  cancel(input: DecisionInput): Promise<DecisionResult>;
  /** 批准后撤销：不回滚决定，只标记 cancelRequested 供执行入口重新检查。 */
  requestCancelAfterApproval(requestId: string): Promise<{ ok: boolean; state: PermissionState; note: string }>;
  /** 执行前最终授权检查 + 原子认领（恰好一次）。 */
  authorizeExecution(input: ClaimExecutionInput): Promise<ClaimExecutionResult>;
  /** 执行中收到撤销：副作用不可追回，如实标记。 */
  reportExecutionCancelRequested(requestId: string): Promise<void>;
  audit(): readonly AuditEntry[];
}

export interface AuditEntry {
  at: number;
  requestId: string;
  event: string;
  by?: string;
  /** 参数摘要；原始参数不进审计。 */
  paramsDigest?: string;
}

export interface PermissionRuntimeOptions {
  store: PermissionStore;
  policy: PermissionPolicy;
  clock?: () => number;
  idFactory?: () => string;
  /** 审计容量上限。 */
  auditLimit?: number;
}

export function createPermissionRuntime(options: PermissionRuntimeOptions): PermissionRuntime {
  const store = options.store;
  const policy = options.policy ?? denyPolicy();
  const clock = options.clock ?? (() => Date.now());
  const idFactory = options.idFactory ?? defaultIdFactory;
  const auditEntries: AuditEntry[] = [];
  const auditLimit = Math.max(10, options.auditLimit ?? 500);

  function audit(entry: AuditEntry): void {
    auditEntries.push(entry);
    if (auditEntries.length > auditLimit) auditEntries.shift();
  }

  return {
    async request(input) {
      const now = input.now ?? clock();
      // unknown 主体默认拒绝：请求都不建。
      if (!input.principalId?.trim() || input.principalId === "unknown") {
        return { ok: false, reason: "unknown-principal" };
      }
      if (!input.conversationId?.trim()) {
        return { ok: false, reason: "missing-conversation" };
      }
      // 策略版本必须与当前实现一致：旧版本请求不接受。
      if (policy.version !== PERMISSION_POLICY_VERSION) {
        return { ok: false, reason: "policy-version-mismatch" };
      }

      const decision = policy.decide({
        category: input.category,
        kind: input.kind,
        principalId: input.principalId,
      });
      if (decision === "deny") {
        audit({ at: now, requestId: "-", event: `deny:${input.kind}`, by: input.principalId });
        return { ok: false, reason: "policy-denied" };
      }

      // 路径类动作：边界检查失败（逃逸/无法解析/换盘）直接拒绝。
      let targetRel: string | undefined;
      let normalizedWorkspace: string | undefined;
      // 有路径参数即走边界检查；无路径动作二者都省略。
      if (input.targetPath !== undefined || input.workspace !== undefined) {
        if (!input.workspace?.trim() || input.targetPath === undefined) {
          return { ok: false, reason: "missing-workspace-or-target" };
        }
        const boundary = checkPathBoundary(input.workspace, input.targetPath, { realPathOf: input.realPathOf });
        if (!boundary.ok) {
          audit({ at: now, requestId: "-", event: `deny:path:${boundary.reason ?? "invalid"}`, by: input.principalId });
          return { ok: false, reason: `path-${boundary.reason ?? "invalid"}` };
        }
        targetRel = boundary.targetRel;
        normalizedWorkspace = input.workspace;
        // 词法判定的事实进审计：后续真实执行入口可以据此加验真实路径。
        if (boundary.assumedLexical) {
          audit({ at: now, requestId: "-", event: "path-boundary:assumed-lexical", by: input.principalId });
        }
      }

      const ttl = Math.min(Math.max(1_000, input.ttlMs ?? MAX_PERMISSION_TTL_MS), MAX_PERMISSION_TTL_MS);
      const request: PermissionRequestV1 = {
        schemaVersion: PERMISSION_SCHEMA_VERSION,
        requestId: idFactory(),
        nonce: idFactory().replace(/-/g, ""),
        principalId: input.principalId,
        conversationId: input.conversationId,
        ...(input.agentSessionId ? { agentSessionId: input.agentSessionId } : {}),
        action: {
          version: 1,
          kind: input.kind,
          category: input.category,
          ...(targetRel !== undefined ? { targetRel } : {}),
          paramsDigest: paramsDigestOf(input.params ?? null),
        },
        ...(normalizedWorkspace ? { workspace: normalizedWorkspace } : {}),
        policyVersion: policy.version,
        createdAt: now,
        expiresAt: now + ttl,
      };
      const record: PermissionRecordV1 = {
        request,
        state: "pending",
        execution: null,
      };
      await store.create(record);
      audit({ at: now, requestId: request.requestId, event: "request", by: input.principalId, paramsDigest: request.action.paramsDigest });

      if (decision === "allow") {
        // 自动放行也走同一条记录：审计与认领口径一致。
        record.state = "approved";
        record.decidedAt = now;
        record.decidedBy = "policy";
        await store.replace(record);
        audit({ at: now, requestId: request.requestId, event: "auto-approve", by: "policy" });
        return { ok: true, record, autoAllowed: true };
      }
      return { ok: true, record, autoAllowed: false };
    },

    async approve(input) {
      await store.get(input.requestId);
      const record = store.current(input.requestId);
      if (!record) return { ok: false, reason: "unknown-request" };
      const now = input.at ?? clock();
      // 审批/撤销竞争的原子性：这里不允许跨 await 的 check-then-act。
      if (record.state === "expired") return { ok: false, reason: "expired" };
      if (record.state !== "pending") return { ok: false, reason: `not-pending:${record.state}` };
      if (now > record.request.expiresAt) {
        const expired: PermissionRecordV1 = { ...record, state: "expired", decidedAt: now };
        await store.replace(expired);
        return { ok: false, reason: "expired" };
      }
      const isGroup = input.by.isGroupConversation === true;
      if (!policy.canApprove({
        category: record.request.action.category,
        approverPrincipalId: input.by.principalId,
        requestPrincipalId: record.request.principalId,
        isGroupConversation: isGroup,
      })) {
        audit({ at: now, requestId: input.requestId, event: "approve-denied", by: input.by.principalId });
        return { ok: false, reason: "approver-not-authorized" };
      }

      const approved: PermissionRecordV1 = { ...record, state: "approved", decidedAt: now, decidedBy: input.by.principalId };
      await store.replace(approved);
      audit({ at: now, requestId: input.requestId, event: "approved", by: input.by.principalId });
      return { ok: true, record: approved };
    },

    async reject(input) {
      await store.get(input.requestId);
      const record = store.current(input.requestId);
      if (!record) return { ok: false, reason: "unknown-request" };
      const now = input.at ?? clock();
      if (record.state !== "pending") return { ok: false, reason: `not-pending:${record.state}` };
      const rejectedRecord: PermissionRecordV1 = { ...record, state: "rejected", decidedAt: now, decidedBy: input.by.principalId };
      await store.replace(rejectedRecord);
      audit({ at: now, requestId: input.requestId, event: "rejected", by: input.by.principalId });
      return { ok: true, record: rejectedRecord };
    },

    async cancel(input) {
      await store.get(input.requestId);
      const record = store.current(input.requestId);
      if (!record) return { ok: false, reason: "unknown-request" };
      const now = input.at ?? clock();
      if (record.state !== "pending") return { ok: false, reason: `not-pending:${record.state}` };
      const cancelled: PermissionRecordV1 = { ...record, state: "cancelled", decidedAt: now, decidedBy: input.by.principalId };
      await store.replace(cancelled);
      audit({ at: now, requestId: input.requestId, event: "cancelled", by: input.by.principalId });
      return { ok: true, record: cancelled };
    },

    async requestCancelAfterApproval(requestId) {
      await store.get(requestId);
      const record = store.current(requestId);
      if (!record) return { ok: false, state: "cancelled", note: "unknown-request" };
      if (record.state !== "approved") {
        return { ok: false, state: record.state, note: "only-approved-requests-accept-cancel-requests" };
      }
      if (record.execution) {
        // 已认领：副作用可能已经发生，不可追回，如实报告。
        await store.replace({
          ...record,
          execution: { ...record.execution, cancelRequested: true },
        });
        return { ok: true, state: "approved", note: "consumed-or-executing;cancel-requested-cannot-revert-side-effects" };
      }
      // 批准后、认领前：标记撤销。authorizeExecution 会重新检查并拒绝认领。
      await store.replace({ ...record, cancelRequested: true });
      audit({ at: clock(), requestId, event: "cancel-requested-after-approval" });
      return { ok: true, state: "approved", note: "cancel-requested;execution-will-be-refused" };
    },

    async authorizeExecution(input) {
      const now = input.at ?? clock();
      // 先 ensureLoaded（重启恢复），再用同步 current() 做 check-and-set——
      // current() 到 replace() 的内存写入之间没有 await，单线程下原子。
      await store.get(input.requestId);
      const record = store.current(input.requestId);
      if (!record) return { ok: false, reason: "unknown-request" };
      // 原子认领：check 与 set 之间没有 await。
      if (record.state !== "approved") return { ok: false, reason: `not-approved:${record.state}` };
      if (record.cancelRequested) return { ok: false, reason: "cancel-requested" };
      if (record.execution) return { ok: false, reason: "already-consumed" };
      if (input.byPrincipalId !== undefined && input.byPrincipalId !== record.request.principalId) {
        return { ok: false, reason: "principal-mismatch" };
      }
      if (input.agentSessionId !== undefined && input.agentSessionId !== record.request.agentSessionId) {
        return { ok: false, reason: "agent-session-mismatch" };
      }
      if (input.nonce !== undefined && input.nonce !== record.request.nonce) {
        return { ok: false, reason: "nonce-mismatch" };
      }
      if (input.params !== undefined && paramsDigestOf(input.params) !== record.request.action.paramsDigest) {
        return { ok: false, reason: "params-changed" };
      }

      const claimed: PermissionRecordV1 = {
        ...record,
        execution: { executionId: input.executionId, consumedAt: now },
      };
      await store.replace(claimed);
      audit({ at: now, requestId: input.requestId, event: "executed", by: record.request.principalId, paramsDigest: record.request.action.paramsDigest });
      return { ok: true, record: claimed, assumedLexical: undefined };
    },

    async reportExecutionCancelRequested(requestId) {
      await store.get(requestId);
      const record = store.current(requestId);
      if (!record?.execution) return;
      await store.replace({
        ...record,
        execution: { ...record.execution, cancelRequested: true },
      });
    },

    audit: () => [...auditEntries],
  };
}

function denyPolicy(): PermissionPolicy {
  // 理论上不会走到（options.policy 必填）；兜底 fail-closed。
  return {
    version: PERMISSION_POLICY_VERSION,
    decide: () => "deny",
    canApprove: () => false,
  };
}

function defaultIdFactory(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `p-${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`;
}
