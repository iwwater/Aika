import { describe, expect, it } from "vitest";
import { createManualClock } from "./fakeEnvironment";
import { createEnvironmentMonitor } from "./monitor";
import { createForegroundSource, FOREGROUND_EVENT, FOREGROUND_SOURCE_ID } from "./foregroundSource";
import { EnvironmentSourceError } from "./contracts";
import { buildEnvironmentSummary } from "./summary";

/**
 * FE-19-A/G：fake bridge 验证前台 source 的 listen→enable→current 时序、
 * epoch/seq 去重、停止清理与失败传播。
 */

interface FakeBridgeState {
  invokes: Array<{ command: string; args: Record<string, unknown> | undefined }>;
  handlers: Map<string, Array<(payload: unknown) => void>>;
  currentPayload: unknown;
  enableError: Error | null;
  listenError: Error | null;
}

function createFakeBridge(overrides: Partial<FakeBridgeState> = {}) {
  const state: FakeBridgeState = {
    invokes: [],
    handlers: new Map(),
    currentPayload: null,
    enableError: null,
    listenError: null,
    ...overrides,
  };
  const bridge = {
    async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
      state.invokes.push({ command, args });
      if (command === "environment_foreground_enable" && state.enableError) throw state.enableError;
      if (command === "environment_foreground_current") return state.currentPayload as T;
      return undefined as T;
    },
    async listen(event: string, handler: (payload: unknown) => void) {
      if (state.listenError) throw state.listenError;
      const list = state.handlers.get(event) ?? [];
      list.push(handler);
      state.handlers.set(event, list);
      return () => {
        state.handlers.set(event, (state.handlers.get(event) ?? []).filter((h) => h !== handler));
      };
    },
  };
  return { bridge, state };
}

describe("foregroundSource（FE-19-A）", () => {
  it("listen → enable → current 兜底时序；current 是 estimated", async () => {
    const { bridge, state } = createFakeBridge({
      currentPayload: { process: "Code.exe", seq: 0, atMs: 1111 },
    });
    const source = createForegroundSource(bridge, { hostEpoch: "e1" });
    const events: Array<{ payload: unknown; precision: string }> = [];
    const stop = await source.start((event) => events.push({ payload: event.payload, precision: event.timingPrecision }), new AbortController().signal);

    expect(state.invokes.map((call) => call.command)).toEqual([
      "environment_foreground_enable",
      "environment_foreground_current",
    ]);
    expect(state.invokes[0].args).toEqual({ enabled: true });
    expect(events).toEqual([{ payload: { kind: "foreground_changed", process: "Code.exe" }, precision: "estimated" }]);

    // 真实 hook 事件：measured，schemaVersion 正确。
    state.handlers.get(FOREGROUND_EVENT)?.[0]({ process: "game.exe", seq: 5, atMs: 2222 });
    expect(events).toHaveLength(2);
    expect(events[1]).toEqual({ payload: { kind: "foreground_changed", process: "game.exe" }, precision: "measured" });

    await stop();
    const lastInvoke = state.invokes[state.invokes.length - 1];
    expect(lastInvoke.command).toBe("environment_foreground_enable");
    expect(lastInvoke.args).toEqual({ enabled: false });
  });

  it("旧 seq / 重复事件去重；current 兜底不覆盖已收到的事件", async () => {
    const { bridge, state } = createFakeBridge({
      currentPayload: { process: "stale.exe", seq: 0, atMs: 1 },
    });
    const source = createForegroundSource(bridge, { hostEpoch: "e1" });
    const processes: string[] = [];
    const stop = await source.start((event) => {
      if (event.payload.kind === "foreground_changed") processes.push(event.payload.process);
    }, new AbortController().signal);

    state.handlers.get(FOREGROUND_EVENT)?.[0]({ process: "a.exe", seq: 3, atMs: 10 });
    // current 兜底后到达 seq=0 的旧兜底：不回退。
    state.handlers.get(FOREGROUND_EVENT)?.[0]({ process: "old.exe", seq: 3, atMs: 11 });
    // 重放同 seq：丢弃。
    state.handlers.get(FOREGROUND_EVENT)?.[0]({ process: "b.exe", seq: 2, atMs: 12 });
    // 新 seq：通过。
    state.handlers.get(FOREGROUND_EVENT)?.[0]({ process: "c.exe", seq: 4, atMs: 13 });

    expect(processes).toEqual(["stale.exe", "a.exe", "c.exe"]);
    await stop();
  });

  it("enable 失败抛 EnvironmentSourceError（unavailable/denied），listen 已撤销", async () => {
    const denied = createFakeBridge({ enableError: new Error("permission denied by user") });
    const source = createForegroundSource(denied.bridge, { hostEpoch: "e1" });
    await expect(source.start(() => undefined, new AbortController().signal)).rejects.toMatchObject({ code: "denied" });
    expect(denied.state.handlers.get(FOREGROUND_EVENT)).toHaveLength(0);

    const unavailable = createFakeBridge({ enableError: new Error("command not found") });
    const source2 = createForegroundSource(unavailable.bridge, { hostEpoch: "e1" });
    await expect(source2.start(() => undefined, new AbortController().signal)).rejects.toMatchObject({ code: "unavailable" });
  });

  it("接入生产 monitor：Rust 消息转成规范事件且无 title；stop 后迟到事件零更新", async () => {
    const clock = createManualClock(0);
    const { bridge, state } = createFakeBridge({
      currentPayload: { process: "Code.exe", seq: 0, atMs: 500 },
    });
    const source = createForegroundSource(bridge, { hostEpoch: "host-e1" });
    const monitor = createEnvironmentMonitor([source], { clock, hostEpoch: "host-e1" });

    // source.start 无 deferred（fake bridge 直接完成），monitor 启动后即 running。
    await monitor.setSourceEnabled(FOREGROUND_SOURCE_ID, true);
    expect(monitor.statuses()[0]).toMatchObject({ state: "running" });

    // 完整事件流出 monitor，且广播事件不含 title 字段。
    const seen: string[] = [];
    monitor.subscribe((event) => seen.push(JSON.stringify(event)));
    state.handlers.get(FOREGROUND_EVENT)?.[0]({ process: "game.exe", seq: 9, atMs: 900, title: "SHOULD-NOT-EXIST" });
    expect(seen.join("\n")).toContain("game.exe");
    expect(seen.join("\n")).not.toContain("SHOULD-NOT-EXIST");

    const summary = buildEnvironmentSummary(monitor, { clock });
    expect(summary.foreground?.process).toBe("game.exe");

    await monitor.setSourceEnabled(FOREGROUND_SOURCE_ID, false);
    // 停止后迟到事件：监听已撤销，快照失效、零广播。
    state.handlers.get(FOREGROUND_EVENT)?.[0]?.({ process: "late.exe", seq: 10, atMs: 999 });
    expect(monitor.snapshot.foreground).toBeNull();
    const seenAfter: string[] = [];
    monitor.subscribe((event) => seenAfter.push(JSON.stringify(event)));
    state.handlers.get(FOREGROUND_EVENT)?.[0]?.({ process: "late.exe", seq: 10, atMs: 999 });
    expect(seenAfter).toEqual([]);
  });

  it("start 抛错映射为 EnvironmentSourceError 而不是裸错误（契约形状）", async () => {
    const { bridge } = createFakeBridge({ listenError: new Error("no ipc") });
    const source = createForegroundSource(bridge, { hostEpoch: "e1" });
    await expect(source.start(() => undefined, new AbortController().signal)).rejects.toBeInstanceOf(EnvironmentSourceError);
  });
});
