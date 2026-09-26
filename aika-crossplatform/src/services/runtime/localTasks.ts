import { token } from "../../kernel";
import { LOCAL_PRINCIPAL_ID } from "../../domain/identity";
import type { Notifier } from "../notification/notifier";
import type { Timers } from "../time/tokens";
import { createPersistentScheduler, type SchedulerTaskV1 } from "./persistentScheduler";

const KEY = "scheduler.localReminders.v1";
const SCOPE = "local:reminder";
type Storage = { getSetting(key: string): Promise<string | null>; setSetting(key: string, value: string): Promise<void> };
type Reminder = { text: string; at: number; notification?: boolean };
export type LocalTask = SchedulerTaskV1 & { text: string; notification?: boolean };
export interface LocalTasks {
  list(): LocalTask[];
  create(text: string, at: number): Promise<void>;
  update(id: string, action: "pause" | "resume" | "cancel"): Promise<void>;
  tick(): Promise<void>;
  dispose(): void;
  error(): string;
}
export const LocalTasksToken = token<LocalTasks>("runtime.localTasks");

/** 单宿主、显式创建的一次本地提醒；正文独立保存，不进入调度摘要或审计。 */
export async function createLocalTasks(options: { storage: Storage; clock: () => number; notifier: Notifier; timers?: Timers }): Promise<LocalTasks> {
  const reminders: Record<string, Reminder> = {};
  const raw = await options.storage.getSetting(KEY);
  if (raw) {
    const parsed = JSON.parse(raw);
    if (parsed.schemaVersion !== 1 || !parsed.reminders || typeof parsed.reminders !== "object") throw new Error("提醒数据无法读取");
    for (const [key, value] of Object.entries(parsed.reminders)) {
      const item = value as Reminder;
      if (typeof item.text !== "string" || item.text.length > 500 || !Number.isFinite(item.at)) throw new Error("提醒数据无效");
      reminders[key] = item;
    }
  }
  const save = () => options.storage.setSetting(KEY, JSON.stringify({ schemaVersion: 1, reminders }));
  let stopped = false;
  let queue = Promise.resolve();
  let timer: unknown;
  let backgroundError = "";
  function serial(work: () => Promise<void>): Promise<void> {
    const result = queue.then(() => { if (stopped) throw new Error("任务服务已停止"); return work(); });
    queue = result.catch(() => {});
    return result;
  }
  const scheduler = createPersistentScheduler({
    loadStorage: async () => options.storage, clock: options.clock,
    authorize: async task => !stopped && task.owner === LOCAL_PRINCIPAL_ID && task.scope === SCOPE
      && task.trigger.kind === "time" && reminders[task.executionKey]?.at === task.trigger.at,
    fire: async task => {
      const reminder = reminders[task.executionKey];
      reminder.notification = await options.notifier.notify({ title: "Aika 定时提醒", body: reminder.text });
      await save();
      return "done";
    },
  });
  const service: LocalTasks = {
    list: () => scheduler.list(LOCAL_PRINCIPAL_ID).filter(task => task.scope === SCOPE).map(task => ({
      ...task, text: reminders[task.executionKey]?.text ?? "提醒内容不可用",
      notification: reminders[task.executionKey]?.notification,
    })),
    create: (text, at) => serial(async () => {
      text = text.trim();
      if (!text || text.length > 500 || !Number.isFinite(at) || at <= options.clock()) throw new Error("请填写 1–500 字的内容和未来时间");
      const key = crypto.randomUUID();
      reminders[key] = { text, at };
      await save();
      const result = await scheduler.scheduleTime({ owner: LOCAL_PRINCIPAL_ID, scope: SCOPE, at,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, executionKey: key });
      if (!result.ok) { delete reminders[key]; await save(); throw new Error(result.reason ?? "创建失败"); }
    }),
    update: (id, action) => serial(async () => {
      if (!service.list().some(task => task.taskId === id)) throw new Error("任务不存在");
      await scheduler[action](id);
    }),
    tick: () => serial(async () => { await scheduler.tick(); }),
    dispose: () => { stopped = true; if (timer !== undefined) options.timers?.clearTimeout(timer); },
    error: () => backgroundError,
  };
  await service.tick();
  function poll() {
    if (stopped || !options.timers) return;
    timer = options.timers.setTimeout(() => {
      void service.tick().then(() => { backgroundError = ""; }).catch(() => { backgroundError = "任务调度失败，请检查存储；结果未知的任务不会自动重放"; }).finally(poll);
    }, 1000);
  }
  poll();
  return service;
}
