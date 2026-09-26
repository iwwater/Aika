import { describe, expect, it, vi } from "vitest";
import { createLocalTasks } from "./localTasks";
import { createPersistentScheduler, SCHEDULER_STORE_KEY } from "./persistentScheduler";

function fixture() {
  const values = new Map<string, string>();
  const storage = { getSetting: async (key: string) => values.get(key) ?? null,
    setSetting: async (key: string, value: string) => { values.set(key, value); } };
  let now = 100000;
  const notify = vi.fn(async () => false);
  const options = { storage, clock: () => now, notifier: { notify } };
  return { storage, values, options, notify, advance: (ms: number) => { now += ms; } };
}
describe("RT-05 宿主本地提醒", () => {
  it("宿主定时器推进任务，dispose 撤销后续轮询", async () => {
    const f = fixture(); let callback = () => {}; const clearTimeout = vi.fn();
    const timers = { setTimeout: vi.fn((handler: () => void) => { callback = handler; return 7; }), clearTimeout };
    const service = await createLocalTasks({ ...f.options, timers });
    await service.create("定时器", 101000); f.advance(1000); callback();
    await service.tick(); expect(f.notify).toHaveBeenCalledTimes(1);
    service.dispose(); expect(clearTimeout).toHaveBeenCalledWith(7);
    await expect(service.tick()).rejects.toThrow("已停止");
  });
  it("存储损坏拒绝加载，不覆盖旧执行记录", async () => {
    const f = fixture(); f.values.set(SCHEDULER_STORE_KEY, "损坏");
    await expect(createLocalTasks(f.options)).rejects.toThrow("scheduler-store-unavailable");
    expect(f.values.get(SCHEDULER_STORE_KEY)).toBe("损坏"); expect(f.notify).not.toHaveBeenCalled();
  });
  it("保存正文、到期执行一次、通知失败如实显示、重开不重放", async () => {
    const f = fixture();
    let service = await createLocalTasks(f.options);
    await service.create("喝水", 101000);
    service.dispose();
    service = await createLocalTasks(f.options);
    expect(service.list()[0].text).toBe("喝水");
    f.advance(1000);
    await Promise.all([service.tick(), service.tick()]);
    expect(f.notify).toHaveBeenCalledTimes(1);
    expect(service.list()[0]).toMatchObject({ state: "done", notification: false });
    service.dispose();
    service = await createLocalTasks(f.options);
    await service.tick();
    expect(f.notify).toHaveBeenCalledTimes(1);
  });
  it("暂停、恢复、取消及离线错过", async () => {
    const f = fixture(); const service = await createLocalTasks(f.options);
    await service.create("暂停", 101000);
    const id = service.list()[0].taskId;
    await service.update(id, "pause"); f.advance(1000); await service.tick();
    expect(f.notify).not.toHaveBeenCalled();
    await service.update(id, "resume"); await service.update(id, "cancel"); await service.tick();
    expect(service.list()[0].state).toBe("cancelled");
    await service.create("离线", 102000); service.dispose(); f.advance(62000);
    const restored = await createLocalTasks(f.options);
    expect(restored.list()[1].state).toBe("missed"); expect(f.notify).not.toHaveBeenCalled();
  });
  it("没有授权器拒绝执行", async () => {
    const f = fixture(); const fire = vi.fn(async () => "done" as const);
    const scheduler = createPersistentScheduler({ loadStorage: async () => f.storage, clock: f.options.clock, fire });
    await scheduler.scheduleTime({ owner: "local", scope: "local", at: 100000 });
    expect((await scheduler.tick()).denied).toBe(1); expect(fire).not.toHaveBeenCalled();
  });
  it("副作用开始前已持久化 unknown；崩溃恢复和抛错均不重放", async () => {
    const f = fixture();
    const fire = vi.fn(async () => {
      expect(JSON.parse(f.values.get(SCHEDULER_STORE_KEY)!).tasks[0].state).toBe("unknown");
      const recovered = createPersistentScheduler({ loadStorage: async () => f.storage, clock: f.options.clock, authorize: async () => true, fire });
      await recovered.tick();
      throw new Error("失去结果");
    });
    const scheduler = createPersistentScheduler({ loadStorage: async () => f.storage, clock: f.options.clock, authorize: async () => true, fire });
    await scheduler.scheduleTime({ owner: "local", scope: "local", at: 100000 }); await scheduler.tick(); await scheduler.tick();
    expect(fire).toHaveBeenCalledTimes(1); expect(scheduler.list()[0].state).toBe("unknown");
  });
});
