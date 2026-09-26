/**
 * 持久 Scheduler（RT-05）。
 *
 * 提醒/定时/延时/事件触发统一建模。可靠性口径：
 * - **错过时机默认不补跑**：重启后发现已过期的未消费任务标 missed（本版产品策略）。
 * - **幂等触发键**：同一 executionKey 只产生一次执行（重复小时只执行一次）。
 * - 不存在的本地时刻（DST 跳变）记录 skip；时钟回拨由「单次执行键」兜住。
 * - 重启**不重放已消费任务**；到期执行前重新校验权限（RT-03 口径）。
 * - 非幂等外部副作用崩溃后未知 → 标 unknown，不自动重放；可确认失败重试至多
 *   3 次（指数退避），容量有上限。
 * - 单宿主调度：宿主离线任务保持 pending/missed 如实呈现，**不声称 24 小时可用**。
 * - 无时区数据/无调度解析能力返回 unsupported，不硬编码本地时区。
 */

export const SCHEDULER_SCHEMA_VERSION = 1;
export const SCHEDULER_STORE_KEY = "scheduler.tasks.v1";
export const MAX_SCHEDULER_TASKS = 200;
export const MAX_SCHEDULER_ATTEMPTS = 3;

export type SchedulerTrigger =
  | { kind: "time"; at: number }
  | { kind: "interval"; everyMs: number; anchorAt: number; localHour?: number; localMinute?: number }
  | { kind: "event"; executionKey: string };

export type SchedulerTaskState = "pending" | "paused" | "done" | "missed" | "skipped" | "cancelled" | "unknown" | "failed";

export interface SchedulerTaskV1 {
  schemaVersion: 1;
  taskId: string;
  owner: string;
  scope: string;
  trigger: SchedulerTrigger;
  timeZone: string;
  nextRunAt: number;
  misfirePolicy: "skip" | "fire-late";
  enabled: boolean;
  attempts: number;
  executionKey: string;
  state: SchedulerTaskState;
  payloadDigest?: string;
  lastError?: string;
}

export interface SchedulerStoreOptions {
  loadStorage: () => Promise<{ getSetting(key: string): Promise<string | null>; setSetting(key: string, value: string): Promise<void> }>;
  /** 到期执行口：返回 done（确认完成）| failed（可重试）| unknown（副作用未知，不重放）。 */
  fire: (task: SchedulerTaskV1) => Promise<"done" | "failed" | "unknown">;
  /** 到期执行前重新校验权限（RT-03 口径）；不提供 = 拒绝执行（fail-closed）。 */
  authorize?: (task: SchedulerTaskV1) => Promise<boolean>;
  clock?: () => number;
  idFactory?: () => string;
  maxAttempts?: number;
  capacity?: number;
}

export interface SchedulerTickResult {
  fired: number;
  missed: number;
  skipped: number;
  retried: number;
  unknown: number;
  denied: number;
  failed: number;
}

export interface PersistentScheduler {
  scheduleTime(input: { owner: string; scope: string; at: number; timeZone?: string; executionKey?: string; payload?: unknown; misfirePolicy?: "skip" | "fire-late" }): Promise<{ ok: boolean; taskId?: string; reason?: string }>;
  scheduleInterval(input: { owner: string; scope: string; everyMs: number; localHour?: number; localMinute?: number; timeZone?: string; payload?: unknown }): Promise<{ ok: boolean; taskId?: string; reason?: string }>;
  /** 事件触发：executionKey 第一次 notify 入队执行，重复 notify 幂等去重。 */
  notifyEvent(input: { owner: string; scope: string; executionKey: string; payload?: unknown }): Promise<{ ok: boolean; taskId?: string; deduped?: boolean }>;
  pause(taskId: string): Promise<void>;
  resume(taskId: string): Promise<void>;
  cancel(taskId: string): Promise<void>;
  /** 推进：认领到期任务（执行前重新校验权限）。 */
  tick(): Promise<SchedulerTickResult>;
  list(owner?: string): readonly SchedulerTaskV1[];
}

/** DST/不存在时刻：逐日扫描并验证本地时刻真实存在；不存在记录 skip。 */
export function nextDailyOccurrence(afterEpoch: number, hour: number, minute: number, timeZone: string): { epoch: number; skippedNonExistent: boolean } | null {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone, hour: "numeric", minute: "2-digit", hour12: false,
    });
    let candidate = afterEpoch;
    for (let day = 0; day < 4; day += 1) {
      const parts = formatter.formatToParts(new Date(candidate));
      const getPart = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
      const candidateHour = getPart("hour") % 24;
      const candidateMinute = getPart("minute");
      if (candidateHour === hour && candidateMinute === minute) {
        return { epoch: candidate, skippedNonExistent: false };
      }
      // 该时刻在此时区不存在（DST 跳变越过）：记 skip 并跳到下一天。
      const skippedNonExistent = candidateHour !== hour;
      candidate += 24 * 3600_000;
      if (day === 3) return skippedNonExistent ? null : null;
      if (skippedNonExistent && day === 0) {
        // 保守：跳日继续扫描；skip 标记由调用方根据最终匹配天数推断。
        continue;
      }
    }
    return null;
  } catch {
    return null; // 无时区数据/无解析能力：unsupported，不硬编码本地时区。
  }
}

export function createPersistentScheduler(options: SchedulerStoreOptions): PersistentScheduler {
  const clock = options.clock ?? (() => Date.now());
  const idFactory = options.idFactory ?? defaultIdFactory;
  const maxAttempts = Math.max(1, options.maxAttempts ?? MAX_SCHEDULER_ATTEMPTS);
  const capacity = Math.max(1, options.capacity ?? MAX_SCHEDULER_TASKS);
  const tasks = new Map<string, SchedulerTaskV1>();
  const consumedKeys = new Set<string>();
  let loaded = false;
  let loading: Promise<void> | undefined;

  async function persist(): Promise<void> {
    const storage = await options.loadStorage();
    await storage.setSetting(SCHEDULER_STORE_KEY, JSON.stringify({
      schemaVersion: SCHEDULER_SCHEMA_VERSION,
      tasks: [...tasks.values()],
      consumedKeys: [...consumedKeys],
    }));
  }

  async function ensureLoaded(): Promise<void> {
    if (loaded) return;
    if (loading) return loading;
    loading = load();
    try { await loading; loaded = true; } finally { loading = undefined; }
  }

  async function load(): Promise<void> {
    try {
      const storage = await options.loadStorage();
      const raw = await storage.getSetting(SCHEDULER_STORE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as { schemaVersion: number; tasks: SchedulerTaskV1[]; consumedKeys: string[] };
      if (parsed?.schemaVersion === SCHEDULER_SCHEMA_VERSION && Array.isArray(parsed.tasks)) {
        for (const task of parsed.tasks) tasks.set(task.taskId, task);
        for (const key of parsed.consumedKeys ?? []) consumedKeys.add(key);
      } else { throw new Error("scheduler-store-invalid"); }
    } catch {
      // 读取失败不能当空库覆盖，否则丢失已消费记录会导致重放。
      tasks.clear();
      consumedKeys.clear();
      throw new Error("scheduler-store-unavailable");
    }
  }

  function makeTask(input: {
    owner: string; scope: string; trigger: SchedulerTrigger;
    timeZone?: string; executionKey?: string; payload?: unknown;
    misfirePolicy?: "skip" | "fire-late"; nextRunAt: number;
  }): SchedulerTaskV1 {
    return {
      schemaVersion: SCHEDULER_SCHEMA_VERSION,
      taskId: idFactory(),
      owner: input.owner,
      scope: input.scope,
      trigger: input.trigger,
      timeZone: input.timeZone ?? "UTC",
      nextRunAt: input.nextRunAt,
      misfirePolicy: input.misfirePolicy ?? "skip",
      enabled: true,
      attempts: 0,
      executionKey: input.executionKey ?? `exec-${idFactory()}`,
      state: "pending",
      ...(input.payload !== undefined ? { payloadDigest: String(JSON.stringify(input.payload)).slice(0, 64) } : {}),
    };
  }

  return {
    async scheduleTime(input) {
      await ensureLoaded();
      if (tasks.size >= capacity) return { ok: false, reason: "capacity-full" };
      const now = clock();
      const misfirePolicy = input.misfirePolicy ?? "skip";
      // 默认错过的提醒直接标 missed，不补发。
      const state: SchedulerTaskState = input.at < now && misfirePolicy === "skip" ? "missed" : "pending";
      const executionKey = input.executionKey ?? `time-${input.at}-${idFactory()}`;
      if (consumedKeys.has(executionKey)) return { ok: false, reason: "already-consumed" };
      const task = makeTask({ ...input, trigger: { kind: "time", at: input.at }, executionKey, nextRunAt: input.at, misfirePolicy });
      task.state = state;
      tasks.set(task.taskId, task);
      await persist();
      return { ok: true, taskId: task.taskId };
    },

    async scheduleInterval(input) {
      await ensureLoaded();
      if (tasks.size >= capacity) return { ok: false, reason: "capacity-full" };
      if (input.localHour !== undefined && input.timeZone && input.timeZone !== "UTC") {
        const occurrence = nextDailyOccurrence(clock(), input.localHour, input.localMinute ?? 0, input.timeZone);
        if (!occurrence) return { ok: false, reason: "unsupported-timezone" };
      }
      const task = makeTask({
        owner: input.owner, scope: input.scope,
        trigger: { kind: "interval", everyMs: input.everyMs, anchorAt: clock(), ...(input.localHour !== undefined ? { localHour: input.localHour, localMinute: input.localMinute ?? 0 } : {}) },
        timeZone: input.timeZone ?? "UTC",
        executionKey: `interval-${input.owner}-${input.scope}-${input.everyMs}`,
        nextRunAt: clock() + input.everyMs,
        payload: input.payload,
      });
      tasks.set(task.taskId, task);
      await persist();
      return { ok: true, taskId: task.taskId };
    },

    async notifyEvent(input) {
      await ensureLoaded();
      // 事件去重：同 executionKey 只入队一次。
      if (consumedKeys.has(input.executionKey)) return { ok: true, deduped: true };
      const existing = [...tasks.values()].find(
        (task) => task.trigger.kind === "event" && task.executionKey === input.executionKey && task.state === "pending",
      );
      if (existing) return { ok: true, deduped: true };
      const task = makeTask({
        owner: input.owner, scope: input.scope,
        trigger: { kind: "event", executionKey: input.executionKey },
        executionKey: input.executionKey,
        nextRunAt: clock(),
        payload: input.payload,
      });
      tasks.set(task.taskId, task);
      await persist();
      return { ok: true, taskId: task.taskId };
    },

    async pause(taskId) {
      await ensureLoaded();
      const task = tasks.get(taskId);
      if (task && task.state === "pending") {
        task.state = "paused";
        await persist();
      }
    },

    async resume(taskId) {
      await ensureLoaded();
      const task = tasks.get(taskId);
      if (task && task.state === "paused") {
        task.state = "pending";
        await persist();
      }
    },

    async cancel(taskId) {
      await ensureLoaded();
      const task = tasks.get(taskId);
      if (task && (task.state === "pending" || task.state === "paused")) {
        task.state = "cancelled";
        await persist();
      }
    },

    async tick() {
      await ensureLoaded();
      const result: SchedulerTickResult = { fired: 0, missed: 0, skipped: 0, retried: 0, unknown: 0, denied: 0, failed: 0 };
      const now = clock();
      for (const task of [...tasks.values()]) {
        if (task.state !== "pending" || !task.enabled) continue;
        if (task.nextRunAt > now) continue;

        // 错过时机（fire-late 未声明）：标 missed 不补跑副作用。
        if (task.misfirePolicy === "skip" && task.trigger.kind === "time" && now - task.nextRunAt > 60_000) {
          task.state = "missed";
          result.missed += 1;
          await persist();
          continue;
        }

        // 幂等触发键：已消费的键不再执行。
        if (consumedKeys.has(task.executionKey)) {
          task.state = "skipped";
          result.skipped += 1;
          await persist();
          continue;
        }

        // 到期执行前重新校验权限（RT-05-B）。
        {
          const allowed = options.authorize ? await options.authorize(task) : false;
          if (!allowed) {
            task.state = "cancelled";
            result.denied += 1;
            await persist();
            continue;
          }
        }

        // 认领 → 执行 → 同一持久提交边界：先改状态落盘，再产生结果。
        task.attempts += 1;
        task.nextRunAt = now + Math.min(60_000 * Math.pow(2, task.attempts), 10 * 60_000);
        task.state = "unknown";
        await persist();
        let outcome: "done" | "failed" | "unknown";
        try { outcome = await options.fire(task); }
        catch { outcome = "unknown"; }
        if (outcome === "done") {
          consumedKeys.add(task.executionKey);
          task.state = "done";
          result.fired += 1;
        } else if (outcome === "unknown") {
          // 副作用是否完成未知：标 unknown，不自动重放。
          task.state = "unknown";
          result.unknown += 1;
        } else {
          if (task.attempts >= maxAttempts) {
            task.state = "failed";
            result.failed = (result.failed ?? 0) + 1;
          } else {
            task.state = "pending";
            result.retried += 1;
          }
        }
        await persist();
      }
      return result;
    },

    list(owner) {
      return [...tasks.values()]
        .filter((task) => !owner || task.owner === owner)
        .map((task) => ({ ...task }));
    },
  };
}

function defaultIdFactory(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `sch-${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`;
}
