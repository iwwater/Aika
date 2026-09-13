/**
 * AgentSession / AgentRun 契约（AGT-01）。
 *
 * 两个概念必须分开：
 * - **AgentSession**：可复用的会话（starting/ready/busy/closed/failed）。
 * - **AgentRun**：会话里的一次任务（queued/running/waiting_approval/waiting_input/
 *   cancelling/completed/failed/cancelled/interrupted）。
 *
 * 一次 ACP session/prompt 结束只结束 Run，Session 仍可 send 开启新 Run——
 * 「终态不复活」针对同一 runId：迟到旧 run 的事件不覆盖新 run。
 */

export const AGENT_SCHEMA_VERSION = 1;

export type AgentSessionState = "starting" | "ready" | "busy" | "closed" | "failed";

export type AgentRunState =
  | "queued"
  | "running"
  | "waiting_approval"
  | "waiting_input"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export const TERMINAL_RUN_STATES: readonly AgentRunState[] = [
  "completed", "failed", "cancelled", "interrupted",
];

export function isTerminalRun(state: AgentRunState): boolean {
  return TERMINAL_RUN_STATES.includes(state);
}

export interface AgentSessionV1 {
  schemaVersion: 1;
  sessionId: string;
  /** ACP 协议侧 session id（adapter 返回）；与本地 sessionId 分开。 */
  acpSessionId?: string;
  /** 规范化后的工作区。 */
  workspace: string;
  ownerPrincipalId: string;
  state: AgentSessionState;
  createdAt: number;
}

export interface AgentRunV1 {
  schemaVersion: 1;
  runId: string;
  sessionId: string;
  /** 启动请求幂等键：同 id 重复 spawn 不生成第二任务。 */
  startRequestId: string;
  state: AgentRunState;
  /** prompt 摘要（日志/持久化都不带原文）。 */
  promptDigest: string;
  createdAt: number;
  updatedAt: number;
  /** 事件序号：同 run 单调。 */
  seq: number;
}

/** 事件日志条目：脱敏——只有状态与摘要，没有 prompt 原文。 */
export interface AgentRunEventV1 {
  runId: string;
  seq: number;
  at: number;
  kind:
    | "spawned" | "queued" | "started" | "waiting_approval" | "waiting_input"
    | "approval-granted" | "approval-denied" | "input-provided"
    | "cancelling" | "completed" | "failed" | "cancelled" | "interrupted" | "timeout";
  detail?: string;
}
