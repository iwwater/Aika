import { describe, expect, it, vi } from "vitest";
import { createPetWindowManager, type PetWindowPort } from "./manager";
import { aggregatePresentation } from "./relay";
import type { PetPresentationData, PetTimers } from "./petPresentation";

/**
 * FE-20-G：fake 窗口生命周期——show/show、show/hide 竞态仅保留期望窗口；
 * 销毁解绑中继订阅；主窗 Runtime/TTS cancel/stop 调用次数为零（结构上：
 * manager/relay 的接口里根本没有这两个入口，这里以 fake Runtime 断言兜底）。
 */

function fakeTimers() {
  const pending = new Map<unknown, () => void>();
  let nextHandle = 1;
  const timers: PetTimers & { run(handle: unknown): void; pendingCount(): number } = {
    setTimeout(handler: () => void) {
      const handle = nextHandle++;
      pending.set(handle, handler);
      return handle;
    },
    clearTimeout(handle: unknown) {
      pending.delete(handle);
    },
    run(handle: unknown) {
      const handler = pending.get(handle);
      if (handler) {
        pending.delete(handle);
        handler();
      }
    },
    pendingCount() {
      return pending.size;
    },
  };
  return timers;
}

interface FakeWindowPortState {
  commands: string[];
  showCount: number;
  hideCount: number;
  broadcastCount: number;
}

function fakePort(): { port: PetWindowPort; state: FakeWindowPortState } {
  const state: FakeWindowPortState = { commands: [], showCount: 0, hideCount: 0, broadcastCount: 0 };
  return {
    state,
    port: {
      async invoke(command: string, args?: Record<string, unknown>) {
        state.commands.push(command);
        if (command === "pet_window_show") state.showCount += 1;
        if (command === "pet_window_hide") state.hideCount += 1;
        if (command === "pet_window_broadcast") state.broadcastCount += 1;
        void args;
        return undefined;
      },
      async listen() {
        return () => undefined;
      },
    },
  };
}

const DATA: PetPresentationData = {
  runtimeTurnId: null,
  speaking: false,
  mood: "neutral",
  currentSubtitle: null,
  lastProactive: null,
};

describe("petWindowManager（FE-20-G）", () => {
  it("open/close 幂等：重复 open 只 show 一次；重复 close 只 hide 一次", async () => {
    const { port, state } = fakePort();
    const timers = fakeTimers();
    const manager = createPetWindowManager({ bridge: port, aggregate: () => DATA, epoch: "e", timers });

    await manager.open();
    await manager.open();
    expect(state.showCount).toBe(1);
    expect(manager.isOpen()).toBe(true);

    await manager.close();
    await manager.close();
    expect(state.hideCount).toBe(1);
    expect(manager.isOpen()).toBe(false);
    // 中继循环已停：无遗留定时器。
    expect(timers.pendingCount()).toBe(0);
  });

  it("show/hide 竞态：创建中被关闭 → 迟到窗口立即销毁", async () => {
    const { port, state } = fakePort();
    const timers = fakeTimers();
    const manager = createPetWindowManager({ bridge: port, aggregate: () => DATA, epoch: "e", timers });

    const first = manager.open();
    const second = manager.close();
    await Promise.all([first, second]);
    // open 之后 generation 被 close 超越 → 迟到的窗口立即销毁。
    // （close 与迟到 open 的善后各 hide 一次，Rust 侧幂等。）
    expect(state.showCount).toBe(1);
    expect(state.hideCount).toBeGreaterThanOrEqual(1);
    expect(manager.isOpen()).toBe(false);
  });

  it("close 后 open：窗口重新打开，中继重启", async () => {
    const { port, state } = fakePort();
    const timers = fakeTimers();
    const manager = createPetWindowManager({ bridge: port, aggregate: () => DATA, epoch: "e", timers });
    await manager.open();
    await manager.close();
    await manager.open();
    expect(manager.isOpen()).toBe(true);
    expect(manager.generation()).toBe(3);
    expect(state.showCount).toBe(2);
    expect(state.hideCount).toBe(1);
  });

  it("主窗 Runtime/TTS 零调用：manager/relay 无 cancel/stop 入口（fake 断言兜底）", async () => {
    const { port } = fakePort();
    const timers = fakeTimers();
    const runtimeCancel = vi.fn();
    const ttsStop = vi.fn();
    const manager = createPetWindowManager({ bridge: port, aggregate: () => DATA, epoch: "e", timers });
    await manager.open();
    await manager.setClickThrough(true);
    await manager.resetPosition();
    await manager.close();
    expect(runtimeCancel).not.toHaveBeenCalled();
    expect(ttsStop).not.toHaveBeenCalled();
    void runtimeCancel;
    void ttsStop;
  });

  it("中继在窗口打开期间把聚合快照经 broadcast 命令送出", async () => {
    const { port, state } = fakePort();
    const timers = fakeTimers();
    let data: PetPresentationData = { ...DATA, speaking: true, currentSubtitle: "こんにちは" };
    const manager = createPetWindowManager({ bridge: port, aggregate: () => data, epoch: "e", timers });
    await manager.open();
    // 节流 tick 触发一次广播。
    timers.run(1);
    expect(state.broadcastCount).toBeGreaterThanOrEqual(1);

    data = { ...DATA };
    timers.run(2);
    expect(state.broadcastCount).toBeGreaterThanOrEqual(2);

    await manager.close();
  });
});

describe("aggregatePresentation（FE-20-B 投影）", () => {
  const fakeCompanion = (messages: unknown[]) => ({
    getSnapshot: () => ({ messages }) as never,
  });
  const fakeVoice = (speakingCaptionId: number | null, captions: { id: number; speaker: string; text: string }[]) => ({
    getSnapshot: () => ({ speakingCaptionId, captions }) as never,
  });

  it("只投影白名单字段：mood/字幕/最近主动消息；普通朗读 runtimeTurnId 为 null", () => {
    const data = aggregatePresentation(
      fakeCompanion([
        { role: "user", content: "hi", createdAt: 1 },
        { role: "assistant", content: "主动问候", source: "proactive", mood: "happy", createdAt: 2 },
        { role: "assistant", content: "回复", mood: "neutral", createdAt: 3 },
      ]),
      fakeVoice(7, [{ id: 7, speaker: "assistant", text: "こんにちは" }]),
    );
    expect(data).toEqual({
      runtimeTurnId: null,
      speaking: true,
      mood: "neutral",
      currentSubtitle: "こんにちは",
      lastProactive: { text: "主动问候", sentAtMs: 2 },
    });
  });

  it("没有语音会话时不伪造说话态", () => {
    const data = aggregatePresentation(
      fakeCompanion([{ role: "assistant", content: "回复", mood: "calm", createdAt: 1 }]),
      null,
    );
    expect(data.speaking).toBe(false);
    expect(data.currentSubtitle).toBeNull();
  });
});
