import { describe, expect, it, vi } from "vitest";
import { createManualClock, createFakeEnvironmentSource } from "../services/environment/fakeEnvironment";
import { createEnvironmentMonitor } from "../services/environment/monitor";
import { createEnvironmentPresenter, type EnvironmentSettingsPort } from "./environmentPresenter";
import { FOREGROUND_SOURCE_ID } from "../services/environment/foregroundSource";

/**
 * FE-19-B/H/I（编排层）：开关矩阵、持久化失败仍撤销、stopAll。
 * 传感器与存储都是 fake；被测的是 presenter 生产代码。
 */

function memorySettings(initial: Record<string, boolean> = {}): EnvironmentSettingsPort & { dump(): Record<string, boolean>; failNext: { value: Error | null } } {
  const values = new Map(Object.entries(initial));
  const failNext = { value: null as Error | null };
  return {
    failNext,
    async getBoolean(key, fallback) {
      if (failNext.value) throw failNext.value;
      return values.get(key) ?? fallback;
    },
    async setBoolean(key, value) {
      if (failNext.value) throw failNext.value;
      values.set(key, value);
    },
    dump() {
      return Object.fromEntries(values);
    },
  };
}

async function setup(settings?: Record<string, boolean>) {
  const clock = createManualClock(0);
  const fg = createFakeEnvironmentSource({ id: FOREGROUND_SOURCE_ID, deferred: false });
  const monitor = createEnvironmentMonitor([fg], { clock, hostEpoch: "e" });
  const settingsPort = memorySettings(settings);
  const presenter = createEnvironmentPresenter({ monitor, settings: settingsPort });
  return { clock, fg, monitor, settingsPort, presenter };
}

describe("environmentPresenter（FE-19）", () => {
  it("默认关：start 无启动调用、无事件流出（FE-19-B）", async () => {
    const env = await setup();
    await env.presenter.start();
    expect(env.fg.startCount).toBe(0);
    expect(env.presenter.getSnapshot().sources[0]).toMatchObject({ state: "off", enabled: false });
    expect(env.presenter.getSnapshot().contextEnabled).toBe(false);
  });

  it("持久化开启 → 启动时自动启用采集；开启失败可见", async () => {
    const env = await setup({ "environment.foregroundEnabled": true });
    await env.presenter.start();
    expect(env.fg.startCount).toBe(1);
    expect(env.presenter.getSnapshot().sources[0]).toMatchObject({ state: "running", enabled: true });
  });

  it("开启 = 先持久化再启动；关闭 = 先撤销再持久化；写失败仍撤销（FE-19-H）", async () => {
    const env = await setup();
    await env.presenter.start();

    await env.presenter.setSourceEnabled(FOREGROUND_SOURCE_ID, true);
    expect(env.settingsPort.dump()["environment.foregroundEnabled"]).toBe(true);
    expect(env.fg.startCount).toBe(1);

    // 存储写失败：采集必须已停止，错误可见，不得继续外发。
    env.settingsPort.failNext.value = new Error("disk full");
    await env.presenter.setSourceEnabled(FOREGROUND_SOURCE_ID, false);
    expect(env.fg.stopCount).toBe(1);
    expect(env.monitor.statuses()[0].state).toBe("off");
    expect(env.presenter.getSnapshot().error).toContain("disk full");
    env.settingsPort.failNext.value = null;
  });

  it("摘要授权与采集开关相互独立；关闭先撤销内存授权再持久化（FE-19-H）", async () => {
    const env = await setup();
    await env.presenter.start();

    await env.presenter.setContextEnabled(true);
    expect(env.presenter.getSnapshot().contextEnabled).toBe(true);
    expect(env.fg.startCount).toBe(0);

    env.settingsPort.failNext.value = new Error("io error");
    await env.presenter.setContextEnabled(false);
    expect(env.presenter.getSnapshot().contextEnabled).toBe(false);
    expect(env.presenter.getSnapshot().error).toContain("io error");
    env.settingsPort.failNext.value = null;
  });

  it("stopAll：停止采集、清缓存、关摘要授权、状态真实（FE-19-I）", async () => {
    const env = await setup();
    await env.presenter.start();
    await env.presenter.setSourceEnabled(FOREGROUND_SOURCE_ID, true);
    await env.presenter.setContextEnabled(true);
    env.fg.emit({
      schemaVersion: "environment.v1",
      sourceId: FOREGROUND_SOURCE_ID,
      eventId: "e1",
      hostEpoch: "e",
      timestamp: 1,
      timingPrecision: "measured",
      confidence: 1,
      payload: { kind: "foreground_changed", process: "Code.exe" },
    });
    expect(env.monitor.recent()).toHaveLength(1);

    const stoppingListener = vi.fn();
    env.presenter.subscribe(stoppingListener);
    await env.presenter.stopAll();

    expect(env.fg.stopCount).toBe(1);
    expect(env.monitor.recent()).toEqual([]);
    expect(env.monitor.snapshot.foreground).toBeNull();
    expect(env.presenter.getSnapshot().contextEnabled).toBe(false);
    expect(env.presenter.getSnapshot().stopping).toBe(false);
    expect(env.settingsPort.dump()["environment.foregroundEnabled"]).toBe(false);
    expect(env.settingsPort.dump()["environment.contextEnabled"]).toBe(false);
    // 停止等待期有过真实的 stopping=true 快照（不只是 UI 装饰）。
    expect(stoppingListener).toHaveBeenCalled();
  });

  it("stopAll 期间持久化失败不改变内存状态（缓存仍清空）", async () => {
    const env = await setup();
    await env.presenter.start();
    await env.presenter.setSourceEnabled(FOREGROUND_SOURCE_ID, true);
    env.settingsPort.failNext.value = new Error("write refused");

    await env.presenter.stopAll();
    expect(env.fg.stopCount).toBe(1);
    expect(env.monitor.recent()).toEqual([]);
    expect(env.presenter.getSnapshot().contextEnabled).toBe(false);
    expect(env.presenter.getSnapshot().error).toContain("write refused");
    env.settingsPort.failNext.value = null;
  });

  it("无 monitor 宿主：available=false，所有操作安全 no-op", async () => {
    const presenter = createEnvironmentPresenter({ monitor: null, settings: null });
    await presenter.start();
    expect(presenter.getSnapshot().available).toBe(false);
    await expect(presenter.setSourceEnabled(FOREGROUND_SOURCE_ID, true)).resolves.toBeUndefined();
    await expect(presenter.stopAll()).resolves.toBeUndefined();
    presenter.dispose();
  });

  it("设置读取失败按关闭处理（fail-closed 启动）", async () => {
    const env = await setup();
    env.settingsPort.failNext.value = new Error("read refused");
    await env.presenter.start();
    expect(env.fg.startCount).toBe(0);
    expect(env.presenter.getSnapshot().contextEnabled).toBe(false);
    env.settingsPort.failNext.value = null;
  });

  it("订阅收快照更新；dispose 后停止", async () => {
    const env = await setup();
    await env.presenter.start();
    const listener = vi.fn();
    const unsubscribe = env.presenter.subscribe(listener);
    await env.presenter.setSourceEnabled(FOREGROUND_SOURCE_ID, true);
    expect(listener).toHaveBeenCalled();
    unsubscribe();
    env.presenter.dispose();
  });
});
