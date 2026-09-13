/**
 * AgentSessionManager（AGT-01）。
 *
 * 与 LLM-04 后台维护完全区分：这里管理的是**多轮 Agent 会话**的生命周期。
 * 硬规则：
 * - spawn/send 以 startRequestId 幂等：同 id 不生成第二任务。
 * - 并发上限默认 1、队列有界；预算用时间/次数/并发这些**可执行的限额**，
 *   不声称不可验证的货币预算。
 * - cancel 先发协议取消，再等有界宽限；超时进入宿主强制结束并**留下实际状态**，
 *   不是点按钮就标成功取消。取消幂等。
 * - 进程崩溃/重启：running 的 Run 标 interrupted（恢复待确认），不假装仍在跑。
 * - 事件日志有界且脱敏（prompt 只留摘要）。
 */

import { paramsDigestOf } from "../../domain/permission";
import {
  isTerminalRun,
  type AgentRunEventV1, type AgentRunState, type AgentRunV1, type AgentSessionV1,
} from "../../domain/agentSession";

export interface AgentAdapterEvent {
  type: "message" | "need_approval" | "need_input" | "completed" | "failed";
  text?: string;
  approvalRequestId?: string;
  error?: string;
}

/** fake/真实 adapter 共同实现的最小协议面。 */
export interface AgentAdapter {
  spawnSession(input: { sessionId: string; workspace: string; ownerPrincipalId: string }): Promise<string>;
  send(input: { sessionId: string; acpSessionId?: string; prompt: string; signal: AbortSignal }): AsyncIterable<AgentAdapterEvent>;
  /** 协议侧取消；宿主强制结束由 manager 在宽限超时后调 forceEnd。 */
  cancel(input: { sessionId: string; acpSessionId?: string }): Promise<void>;
  forceEnd?(input: { sessionId: string; acpSessionId?: string }): Promise<void>;
}

export interface AgentSessionManagerOptions {
  adapter: AgentAdapter;
  maxConcurrentRuns?: number;
  queueLimit?: number;
  /** 单 Run 时间预算；超时 → cancelling → failed。 */
  runTimeoutMs?: number;
  /** cancel 后等协议确认的宽限。 */
  cancelGraceMs?: number;
  /** 事件日志条数上限（有界）。 */
  logLimit?: number;
  clock?: () => number;
  idFactory?: () => string;
  timers?: { set(handler: () => void, ms: number): unknown; clear(handle: unknown): void };
}

export interface AgentSessionManager {
  spawnSession(input: { workspace: string; ownerPrincipalId: string }): Promise<{ sessionId: string }>;
  /** startRequestId 幂等：重复调用返回同一 runId，不生成第二任务。 */
  send(input: { sessionId: string; prompt: string; startRequestId: string }): Promise<{ ok: boolean; runId?: string; reason?: string }>;
  /** 幂等取消：协议取消 → 有界宽限 → 强制结束并留实际状态。 */
  cancel(input: { runId: string; reason?: string }): Promise<{ ok: boolean; state?: AgentRunState; reason?: string }>;
  resolveApproval(input: { runId: string; approvalRequestId: string; approve: boolean }): { ok: boolean };
  provideInput(input: { runId: string; text: string }): { ok: boolean };
  runs(): readonly AgentRunV1[];
  events(): readonly AgentRunEventV1[];
  /** 崩溃恢复：running/waiting 的 Run 标 interrupted。 */
  recover(): number;
  subscribe(listener: (run: AgentRunV1) => void): () => void;
  dispose(): void;
}

export function createAgentSessionManager(options: AgentSessionManagerOptions): AgentSessionManager {
  const clock = options.clock ?? (() => Date.now());
  const idFactory = options.idFactory ?? defaultIdFactory;
  const timers = options.timers ?? {
    set: (handler: () => void, ms: number) => setTimeout(handler, ms),
    clear: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  const maxConcurrentRuns = Math.max(1, options.maxConcurrentRuns ?? 1);
  const queueLimit = Math.max(1, options.queueLimit ?? 8);
  const runTimeoutMs = options.runTimeoutMs ?? 10 * 60_000;
  const cancelGraceMs = options.cancelGraceMs ?? 5_000;
  const logLimit = Math.max(10, options.logLimit ?? 200);

  const sessions = new Map<string, AgentSessionV1>();
  const runs = new Map<string, AgentRunV1 & { controller?: AbortController }>();
  const events: AgentRunEventV1[] = [];
  /** spawn 幂等键：startRequestId → runId。 */
  const startRequests = new Map<string, string>();
  const listeners = new Set<(run: AgentRunV1) => void>();
  const waitingTimers = new Map<string, unknown>();

  let disposed = false;

  function log(runId: string, kind: AgentRunEventV1["kind"], detail?: string): void {
    const run = runs.get(runId);
    events.push({ runId, seq: run ? (run.seq += 1) : 0, at: clock(), kind, ...(detail ? { detail } : {}) });
    if (events.length > logLimit) events.splice(0, events.length - logLimit);
    if (run) for (const listener of [...listeners]) {
      try {
        listener(run);
      } catch {
        // 订阅者异常不影响生命周期。
      }
    }
  }

  function transition(runId: string, state: AgentRunState): void {
    const run = runs.get(runId);
    if (!run || run.state === state) return;
    run.state = state;
    run.updatedAt = clock();
    log(runId, state === "running" ? "started" : (state as AgentRunEventV1["kind"]));
    for (const listener of [...listeners]) {
      try {
        listener(run);
      } catch {
        // 隔离。
      }
    }
  }

  function drain(): void {
    if (disposed) return;
    let running = [...runs.values()].filter((run) => run.state === "running").length;
    while (running < maxConcurrentRuns) {
      const next = [...runs.values()]
        .filter((run) => run.state === "queued")
        .sort((a, b) => a.createdAt - b.createdAt)[0];
      if (!next) break;
      void startRun(next);
      running += 1;
    }
  }

  async function startRun(run: AgentRunV1 & { controller?: AbortController }): Promise<void> {
    const session = sessions.get(run.sessionId);
    if (!session) {
      transition(run.runId, "failed");
      return;
    }
    session.state = "busy";
    transition(run.runId, "running");
    const controller = new AbortController();
    run.controller = controller;
    const timeoutHandle = timers.set(() => {
      if (run.state === "running") {
        log(run.runId, "timeout");
        void cancelInternal(run.runId, "timeout");
      }
    }, runTimeoutMs);

    try {
      for await (const event of options.adapter.send({
        sessionId: run.sessionId, acpSessionId: session.acpSessionId,
        prompt: `digest:${run.promptDigest}`, signal: controller.signal,
      })) {
        if (isTerminalRun(run.state)) return;
        if (event.type === "message") continue; // 正文不进状态机/日志。
        if (event.type === "need_approval") {
          transition(run.runId, "waiting_approval");
          continue;
        }
        if (event.type === "need_input") {
          transition(run.runId, "waiting_input");
          continue;
        }
        if (event.type === "failed") {
          timers.clear(timeoutHandle);
          transition(run.runId, "failed");
          return;
        }
        if (event.type === "completed") {
          timers.clear(timeoutHandle);
          transition(run.runId, "completed");
          return;
        }
      }
      timers.clear(timeoutHandle);
      if (!isTerminalRun(run.state)) {
        // 协议流自然结束：cancelling 落为 cancelled，其余落为 completed。
        transition(run.runId, run.state === "cancelling" ? "cancelled" : "completed");
      }
    } catch (error) {
      timers.clear(timeoutHandle);
      if (isTerminalRun(run.state)) return;
      transition(run.runId, "failed");
      log(run.runId, "failed", error instanceof Error ? error.message.slice(0, 80) : undefined);
    } finally {
      session.state = "ready";
    }
  }

  async function cancelInternal(runId: string, reason?: string): Promise<void> {
    const run = runs.get(runId);
    if (!run || isTerminalRun(run.state)) return;
    const session = sessions.get(run.sessionId);
    if (run.state === "queued") {
      transition(runId, "cancelled");
      return;
    }
    transition(runId, "cancelling");
    log(runId, "cancelling", reason);
    try {
      await options.adapter.cancel({ sessionId: run.sessionId, acpSessionId: session?.acpSessionId });
    } catch {
      // 协议取消失败也要走强制结束路径。
    }
    // 协议取消已发出：中止 adapter 流（宽限结束后由强制结束兜底）。
    run.controller?.abort();
    // 有界宽限：等协议侧收尾；超时强制结束并留实际状态。
    const timer = timers.set(() => {
      const current = runs.get(runId);
      if (!current || isTerminalRun(current.state)) return;
      options.adapter.forceEnd?.({ sessionId: run.sessionId, acpSessionId: session?.acpSessionId });
      transition(runId, "failed");
      log(runId, "failed", "force-ended-after-grace");
    }, cancelGraceMs);
    waitingTimers.set(runId, timer);
  }

  return {
    async spawnSession(input) {
      const sessionId = idFactory();
      const session: AgentSessionV1 = {
        schemaVersion: 1,
        sessionId,
        workspace: input.workspace,
        ownerPrincipalId: input.ownerPrincipalId,
        state: "starting",
        createdAt: clock(),
      };
      sessions.set(sessionId, session);
      try {
        session.acpSessionId = await options.adapter.spawnSession({
          sessionId, workspace: input.workspace, ownerPrincipalId: input.ownerPrincipalId,
        });
        session.state = "ready";
      } catch {
        session.state = "failed";
      }
      return { sessionId };
    },

    async send(input) {
      const session = sessions.get(input.sessionId);
      if (!session || session.state === "closed" || session.state === "failed") {
        return { ok: false, reason: "session-not-ready" };
      }
      // spawn 幂等：同 startRequestId 返回同一 runId。
      const existing = startRequests.get(input.startRequestId);
      if (existing) {
        const run = runs.get(existing);
        if (run && !isTerminalRun(run.state)) return { ok: true, runId: existing };
      }

      const queuedCount = [...runs.values()].filter((run) => run.state === "queued").length;
      if (queuedCount >= queueLimit) return { ok: false, reason: "queue-full" };

      const runId = idFactory();
      const run: AgentRunV1 & { controller?: AbortController } = {
        schemaVersion: 1,
        runId,
        sessionId: input.sessionId,
        startRequestId: input.startRequestId,
        state: "queued",
        // prompt 原文不落日志/持久化，只留摘要。
        promptDigest: paramsDigestOf(input.prompt),
        createdAt: clock(),
        updatedAt: clock(),
        seq: 0,
      };
      runs.set(runId, run);
      startRequests.set(input.startRequestId, runId);
      log(runId, "queued");
      drain();
      return { ok: true, runId };
    },

    async cancel(input) {
      const run = runs.get(input.runId);
      if (!run) return { ok: false, reason: "unknown-run" };
      if (isTerminalRun(run.state)) {
        // 取消幂等：已终态再取消直接返回成功与实际状态。
        return { ok: true, state: run.state };
      }
      await cancelInternal(input.runId, input.reason);
      return { ok: true, state: runs.get(input.runId)?.state };
    },

    resolveApproval(input) {
      const run = runs.get(input.runId);
      if (!run || run.state !== "waiting_approval") return { ok: false };
      log(input.runId, input.approve ? "approval-granted" : "approval-denied");
      transition(input.runId, input.approve ? "running" : "failed");
      return { ok: true };
    },

    provideInput(input) {
      const run = runs.get(input.runId);
      if (!run || run.state !== "waiting_input") return { ok: false };
      log(input.runId, "input-provided");
      transition(input.runId, "running");
      return { ok: true };
    },

    runs: () => [...runs.values()],

    events: () => [...events],

    recover() {
      let count = 0;
      for (const run of runs.values()) {
        if (run.state === "running" || run.state === "waiting_approval" || run.state === "waiting_input" || run.state === "cancelling") {
          transition(run.runId, "interrupted");
          log(run.runId, "interrupted", "recovery-mark");
          count += 1;
        }
      }
      return count;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    dispose() {
      disposed = true;
      for (const handle of waitingTimers.values()) timers.clear(handle);
      waitingTimers.clear();
      listeners.clear();
    },
  };
}

function defaultIdFactory(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `agt-${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`;
}
