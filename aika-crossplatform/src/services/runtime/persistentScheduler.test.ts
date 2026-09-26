import { describe, expect, it } from "vitest";
import type { AikaStorage } from "../storage/contracts";
import { createPersistentScheduler, MAX_SCHEDULER_ATTEMPTS } from "./persistentScheduler";

const BASE = Date.UTC(2026, 0, 10, 12, 0);
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

interface Fixture {
  scheduler: ReturnType<typeof buildScheduler>;
  settings: Map<string, string>;
  firedKeys: string[];
  setAuthorized(value: boolean): void;
  tick(ms: number): void;
  advanceAndTick(ms?: number): Promise<void>;
  rebuild(): void;
  currentNow(): number;
}

function buildScheduler(settings: Map<string, string>, clock: () => number, state: { authorized: boolean; firedKeys: string[] }) {
  const storage = {
    async getSetting(key: string) { return settings.get(key) ?? null; },
    async setSetting(key: string, value: string) { settings.set(key, value); },
  } as unknown as AikaStorage;
  return createPersistentScheduler({
    loadStorage: async () => storage,
    clock,
    authorize: async () => state.authorized,
    fire: async (task) => {
      state.firedKeys.push(task.executionKey);
      return "done";
    },
  });
}

function makeFixture(initialAuthorized = true): Fixture {
  const settings = new Map<string, string>();
  const state = { authorized: initialAuthorized, firedKeys: [] as string[] };
  let now = BASE;
  let scheduler = buildScheduler(settings, () => now, state);
  const fixture: Fixture = {
    settings,
    firedKeys: state.firedKeys,
    setAuthorized: (value) => {
      state.authorized = value;
    },
    tick: (ms: number) => { now += ms; },
    async advanceAndTick(ms = 0) {
      now += ms;
      await scheduler.tick();
      await flush();
    },
    rebuild() {
      scheduler = buildScheduler(settings, () => now, state);
    },
    currentNow: () => now,
    scheduler,
  };
  // scheduler 保持最新实例（rebuild 后自动指向新实例）。
  Object.defineProperty(fixture, "scheduler", {
    get: () => scheduler,
    configurable: true,
  });
  return fixture;
}

describe("持久 Scheduler（RT-05）", () => {
  it("定时任务到期执行一次；重复 executionKey 不再触发（RT-05-A/B）", async () => {
    const fixture = makeFixture();
    await fixture.scheduler.scheduleTime({ owner: "local", scope: "local", at: BASE + 1000, executionKey: "remind-1" });
    await fixture.advanceAndTick(500);
    expect(fixture.firedKeys).toEqual([]);
    await fixture.advanceAndTick(600);
    expect(fixture.firedKeys).toEqual(["remind-1"]);

    // 同键重复入队（幂等触发键）：再 tick 不重复触发。
    await fixture.scheduler.scheduleTime({ owner: "local", scope: "local", at: fixture.currentNow() + 1000, executionKey: "remind-1" });
    await fixture.advanceAndTick(2000);
    expect(fixture.firedKeys).toEqual(["remind-1"]);
  });

  it("重启不重放已消费任务（RT-05-B）", async () => {
    const fixture = makeFixture();
    await fixture.scheduler.scheduleTime({ owner: "local", scope: "local", at: BASE + 1000, executionKey: "remind-2" });
    await fixture.advanceAndTick(2000);
    expect(fixture.firedKeys).toEqual(["remind-2"]);

    fixture.rebuild(); // 同库新实例 = 重启。
    await fixture.scheduler.tick();
    expect(fixture.firedKeys).toEqual(["remind-2"]);
  });

  it("错过的时机默认标 missed 不补跑；暂停/恢复/取消各自生效（RT-05-A）", async () => {
    const fixture = makeFixture();
    await fixture.scheduler.scheduleTime({ owner: "local", scope: "local", at: BASE + 1000 });
    fixture.tick(10 * 60_000); // 明显错过。
    await fixture.scheduler.tick();
    const missed = fixture.scheduler.list().find((task) => task.state === "missed");
    expect(missed).toBeTruthy();
    expect(fixture.firedKeys).toHaveLength(0);

    // 暂停：到期不执行；恢复后照常。
    const pauseAt = fixture.currentNow();
    await fixture.scheduler.scheduleTime({ owner: "local", scope: "local", at: pauseAt + 1000, executionKey: "paused-task" });
    const paused = fixture.scheduler.list().find((task) => task.executionKey === "paused-task");
    await fixture.scheduler.pause(paused?.taskId as string);
    await fixture.advanceAndTick(2000);
    expect(fixture.firedKeys).not.toContain("paused-task");
    await fixture.scheduler.resume(paused?.taskId as string);
    await fixture.advanceAndTick(1);
    expect(fixture.firedKeys).toContain("paused-task");

    // 取消：不再执行。
    const cancelAt = fixture.currentNow();
    await fixture.scheduler.scheduleTime({ owner: "local", scope: "local", at: cancelAt + 1000, executionKey: "cancelled-task" });
    const cancelled = fixture.scheduler.list().find((task) => task.executionKey === "cancelled-task");
    await fixture.scheduler.cancel(cancelled?.taskId as string);
    await fixture.advanceAndTick(2000);
    expect(fixture.firedKeys).not.toContain("cancelled-task");
  });

  it("到期执行前重新校验权限：未授权 → cancelled 0 触发（RT-05-B/D）", async () => {
    const fixture = makeFixture(false);
    await fixture.scheduler.scheduleTime({ owner: "local", scope: "local", at: BASE + 1000 });
    await fixture.advanceAndTick(2000);
    expect(fixture.firedKeys).toEqual([]);
    expect(fixture.scheduler.list().filter((task) => task.state === "cancelled")).toHaveLength(1);
  });

  it("事件触发：同 executionKey 重复 notify 幂等去重（RT-05-A）", async () => {
    const fixture = makeFixture();
    const first = await fixture.scheduler.notifyEvent({ owner: "local", scope: "local", executionKey: "evt-1" });
    expect(first.ok).toBe(true);
    const second = await fixture.scheduler.notifyEvent({ owner: "local", scope: "local", executionKey: "evt-1" });
    expect(second.deduped).toBe(true);
    await fixture.advanceAndTick(1);
    expect(fixture.firedKeys).toEqual(["evt-1"]);
  });

  it("非幂等副作用 unknown：标 unknown 不自动重放（RT-05-B/全文审阅）", async () => {
    const settings = new Map<string, string>();
    let now = BASE;
    let attempts = 0;
    const scheduler = createPersistentScheduler({
      loadStorage: async () => {
        const storage = {
          async getSetting(key: string) { return settings.get(key) ?? null; },
          async setSetting(key: string, value: string) { settings.set(key, value); },
        };
        return storage as AikaStorage;
      },
      clock: () => now,
      authorize: async () => true,
      fire: async () => {
        attempts += 1;
        return "unknown";
      },
    });
    await scheduler.scheduleTime({ owner: "local", scope: "local", at: BASE + 1000, executionKey: "side-effect-1", misfirePolicy: "fire-late" });
    now += 2000;
    await scheduler.tick();
    await flush();
    expect(attempts).toBe(1);
    expect(scheduler.list().find((task) => task.executionKey === "side-effect-1")?.state).toBe("unknown");
    now += 60_000;
    await scheduler.tick();
    expect(attempts).toBe(1);
  });

  it("可确认失败重试至多 MAX_ATTEMPTS 次（RT-05 全文审阅）", async () => {
    const settings = new Map<string, string>();
    let now = BASE;
    let attempts = 0;
    const scheduler = createPersistentScheduler({
      loadStorage: async () => {
        const storage = {
          async getSetting(key: string) { return settings.get(key) ?? null; },
          async setSetting(key: string, value: string) { settings.set(key, value); },
        };
        return storage as AikaStorage;
      },
      clock: () => now,
      authorize: async () => true,
      fire: async () => {
        attempts += 1;
        return "failed";
      },
    });
    await scheduler.scheduleTime({ owner: "local", scope: "local", at: BASE + 1000, executionKey: "retry-1", misfirePolicy: "fire-late" });
    for (let index = 0; index < MAX_SCHEDULER_ATTEMPTS + 2; index += 1) {
      now += 15 * 60_000;
      await scheduler.tick();
    }
    expect(attempts).toBe(MAX_SCHEDULER_ATTEMPTS);
    expect(scheduler.list().find((task) => task.executionKey === "retry-1")?.state).toBe("failed");
  });

  it("不支持时区/坏时区：scheduleInterval 明确 unsupported（RT-05 全文审阅）", async () => {
    const fixture = makeFixture();
    const bad = await fixture.scheduler.scheduleInterval({
      owner: "local", scope: "local", everyMs: 3600_000,
      localHour: 9, timeZone: "Not/AZone",
    });
    expect(bad.ok).toBe(false);
  });
});
