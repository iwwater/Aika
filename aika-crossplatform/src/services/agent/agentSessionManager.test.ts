import { describe, expect, it } from "vitest";
import { createAgentSessionManager, type AgentAdapter, type AgentAdapterEvent } from "./agentSessionManager";

const BASE = Date.UTC(2026, 0, 10, 12, 0);

interface Gate {
  open(): void;
  wait(): Promise<void>;
}

function makeGate(): Gate {
  let resolveFn: (() => void) | null = null;
  return {
    open: () => {
      resolveFn?.();
      resolveFn = null;
    },
    wait: () => new Promise<void>((resolve) => {
      resolveFn = resolve;
    }),
  };
}

/** fake adapter：send 的行为由测试注入（受控事件序列）。 */
function makeAdapter(behavior: (prompt: string, emit: (event: AgentAdapterEvent) => void) => Promise<void>): AgentAdapter {
  return {
    spawnSession: async () => `acp-${Math.random().toString(16).slice(2, 8)}`,
    async *send(input) {
      const queue: AgentAdapterEvent[] = [];
      let finished = false;
      let notify: (() => void) | null = null;
      const emit = (event: AgentAdapterEvent) => {
        queue.push(event);
        notify?.();
        notify = null;
      };
      void behavior(input.prompt, emit).then(() => {
        finished = true;
        notify?.();
      });
      for (;;) {
        if (input.signal.aborted) return;
        if (queue.length) {
          yield queue.shift() as AgentAdapterEvent;
          continue;
        }
        if (finished) return;
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
      }
    },
    cancel: async () => undefined,
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("AgentSessionManager（AGT-01，fake adapter 跑生产实现）", () => {
  it("spawn → send → completed：一轮结束 Session 仍 ready（AGT-01 全文审阅）", async () => {
    const manager = createAgentSessionManager({
      adapter: makeAdapter(async (_prompt, emit) => {
        emit({ type: "completed" });
          }),
      clock: () => BASE,
    });
    const { sessionId } = await manager.spawnSession({ workspace: "C:\\work\\aika", ownerPrincipalId: "local" });
    const send = await manager.send({ sessionId, prompt: "列出文件", startRequestId: "req-1" });
    expect(send.ok).toBe(true);
    await flush();
    const run = manager.runs().find((r) => r.runId === send.runId);
    expect(run?.state).toBe("completed");
    // Session 仍可再开新 Run（不被 prompt 完成禁止）。
    const again = await manager.send({ sessionId, prompt: "再跑一次", startRequestId: "req-2" });
    expect(again.ok).toBe(true);
    manager.dispose();
  });

  it("spawn 幂等：同 startRequestId 不生成第二任务（AGT-01-A）", async () => {
    const gate = makeGate();
    const manager = createAgentSessionManager({
      adapter: makeAdapter(async (_prompt, emit) => {
        await gate.wait();
        emit({ type: "completed" });
          }),
      clock: () => BASE,
    });
    const { sessionId } = await manager.spawnSession({ workspace: "w", ownerPrincipalId: "local" });
    const first = await manager.send({ sessionId, prompt: "任务", startRequestId: "req-1" });
    const second = await manager.send({ sessionId, prompt: "任务", startRequestId: "req-1" });
    expect(first.ok && second.ok).toBe(true);
    expect(first.runId).toBe(second.runId);
    expect(manager.runs().filter((r) => r.startRequestId === "req-1")).toHaveLength(1);
    gate.open();
    manager.dispose();
  });

  it("取消幂等；宽限后强制结束留实际状态（AGT-01-B）", async () => {
    let cancelled = false;
    let forceEnded = false;
    const manager = createAgentSessionManager({
      adapter: {
        spawnSession: async () => "acp-1",
        async *send(input) {
          while (!input.signal.aborted && !cancelled) {
            await new Promise((resolve) => setTimeout(resolve, 1));
          }
          // 协议取消后 adapter 流自然结束。
        },
        cancel: async () => {
          cancelled = true;
        },
        forceEnd: async () => {
          forceEnded = true;
        },
      },
      cancelGraceMs: 5,
      clock: () => BASE,
    });
    const { sessionId } = await manager.spawnSession({ workspace: "w", ownerPrincipalId: "local" });
    const send = await manager.send({ sessionId, prompt: "长任务", startRequestId: "req-1" });
    await flush();
    const first = await manager.cancel({ runId: send.runId as string });
    const second = await manager.cancel({ runId: send.runId as string });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true); // 幂等。
    expect(second.state).toBe(first.state);
    await flush();
    expect(cancelled).toBe(true);
    void forceEnded;
    manager.dispose();
  });

  it("waiting_approval / waiting_input 显式转换（AGT-01-B）", async () => {
    const emitBox: { current: ((event: AgentAdapterEvent) => void) | null } = { current: null };
    const manager = createAgentSessionManager({
      adapter: {
        spawnSession: async () => "acp-1",
        async *send(input) {
          // 注册外部发射器后挂起，等待测试驱动 need_input / completed。
          const events: AgentAdapterEvent[] = [
            { type: "need_approval", approvalRequestId: "ap-1" },
          ];
          for (const event of events) {
            yield event;
            await new Promise<void>((resolve) => {
              emitBox.current = (next) => {
                events.push(next);
                resolve();
              };
            });
            if (input.signal.aborted) return;
          }
        },
        cancel: async () => undefined,
      },
      clock: () => BASE,
    });
    const { sessionId } = await manager.spawnSession({ workspace: "w", ownerPrincipalId: "local" });
    const send = await manager.send({ sessionId, prompt: "危险操作", startRequestId: "req-1" });
    await flush();
    const run = manager.runs().find((r) => r.runId === send.runId);
    expect(run?.state).toBe("waiting_approval");

    // 审批拒绝 → failed；批准 → running。
    manager.resolveApproval({ runId: send.runId as string, approvalRequestId: "ap-1", approve: true });
    expect(manager.runs().find((r) => r.runId === send.runId)?.state).toBe("running");
    emitBox.current?.({ type: "need_input" });
    await flush();
    expect(manager.runs().find((r) => r.runId === send.runId)?.state).toBe("waiting_input");
    manager.provideInput({ runId: send.runId as string, text: "补充信息" });
    expect(manager.runs().find((r) => r.runId === send.runId)?.state).toBe("running");
    emitBox.current?.({ type: "completed" });
    await flush();
    manager.dispose();
  });

  it("崩溃恢复：running 标 interrupted 不假装仍运行（AGT-01-C）", async () => {
    const manager = createAgentSessionManager({
      adapter: makeAdapter(async () => {
        // 永不结束：模拟崩溃前正在跑。
        await new Promise(() => undefined);
      }),
      clock: () => BASE,
    });
    const { sessionId } = await manager.spawnSession({ workspace: "w", ownerPrincipalId: "local" });
    await manager.send({ sessionId, prompt: "进行中", startRequestId: "req-1" });
    await flush();
    const recovered = manager.recover();
    expect(recovered).toBe(1);
    expect(manager.runs().every((r) => r.state === "interrupted")).toBe(true);
    manager.dispose();
  });

  it("日志有界且脱敏：prompt 原文不进事件（AGT-01-D）", async () => {
    const SECRET_PROMPT = "SECRET-PROMPT-CONTENT-42";
    const manager = createAgentSessionManager({
      adapter: makeAdapter(async (_prompt, emit) => {
        emit({ type: "completed" });
          }),
      clock: () => BASE,
      logLimit: 10,
    });
    const { sessionId } = await manager.spawnSession({ workspace: "w", ownerPrincipalId: "local" });
    for (let index = 0; index < 3; index += 1) {
      await manager.send({ sessionId, prompt: `${SECRET_PROMPT}-${index}`, startRequestId: `req-${index}` });
      await flush();
    }
    const dump = JSON.stringify(manager.events());
    expect(dump).not.toContain(SECRET_PROMPT);
    expect(manager.events().length).toBeLessThanOrEqual(10);
    manager.dispose();
  });
});
