/** 装配完成后的可选能力启停；不改变核心插件的启动事务。 */
export type CapabilityState = "off" | "starting" | "running" | "stopping" | "failed";
export interface CapabilityHealth {
  state: CapabilityState;
  generation: number;
  code?: "start_failed" | "stop_failed" | "health_failed" | "timeout";
}
export interface OptionalCapabilityOptions {
  start(signal: AbortSignal): Promise<() => void | Promise<void>>;
  check?(): Promise<boolean>;
  timeoutMs?: number;
}

export function createOptionalCapability(options: OptionalCapabilityOptions) {
  let current: CapabilityHealth = { state: "off", generation: 0 };
  let controller: AbortController | null = null;
  let pending: Promise<void> | null = null;
  let stopping: Promise<CapabilityHealth> | null = null;
  let cleanup: (() => void | Promise<void>) | null = null;
  let starting: Promise<CapabilityHealth> | null = null;
  const listeners = new Set<(health: CapabilityHealth) => void>();
  const timeoutMs = options.timeoutMs ?? 3000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("invalid timeout");

  function update(state: CapabilityState, code?: CapabilityHealth["code"]) {
    current = { state, generation: current.generation, ...(code ? { code } : {}) };
    for (const listener of [...listeners]) {
      try { listener({ ...current }); } catch { /* 隔离订阅者 */ }
    }
  }
  async function bounded(task: Promise<unknown>): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        task.then(() => true),
        new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
      ]);
    } finally { clearTimeout(timer); }
  }
  async function release() {
    const fn = cleanup;
    cleanup = null;
    await fn?.();
  }
  function track(task: Promise<void>) {
    pending = task;
    void task.finally(() => { if (pending === task) pending = null; }).catch(() => undefined);
    return task;
  }

  return {
    snapshot: (): CapabilityHealth => ({ ...current }),
    subscribe(listener: (health: CapabilityHealth) => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    start(): Promise<CapabilityHealth> {
      if (starting) return starting;
      // 挂起的旧实例仍占有资源时禁止重叠启动。
      if (pending || stopping || cleanup || current.state === "running") return Promise.resolve({ ...current });
      const epoch = ++current.generation;
      controller = new AbortController();
      const signal = controller.signal;
      update("starting");
      const task = track((async () => {
        try {
          const dispose = await options.start(signal);
          if (signal.aborted || current.generation !== epoch) {
            await dispose();
            return;
          }
          cleanup = dispose;
          update("running");
        } catch {
          if (current.generation === epoch) update("failed", "start_failed");
        }
      })());
      starting = (async () => {
        if (!await bounded(task) && current.generation === epoch) {
          controller?.abort();
          ++current.generation;
          update("failed", "timeout");
        }
        return { ...current };
      })().finally(() => { starting = null; });
      return starting;
    },
    stop(): Promise<CapabilityHealth> {
      if (stopping) return stopping;
      if (current.state === "off" && !pending && !cleanup) return Promise.resolve({ ...current });
      ++current.generation;
      controller?.abort();
      update("stopping");
      const previous = pending;
      const task = track((async () => { await previous; await release(); })());
      stopping = (async () => {
        try {
          const completed = await bounded(task);
          update(completed ? "off" : "failed", completed ? undefined : "timeout");
        } catch { update("failed", "stop_failed"); }
        return { ...current };
      })().finally(() => { stopping = null; });
      return stopping;
    },
    async health(): Promise<CapabilityHealth> {
      if (current.state !== "running" || !options.check) return { ...current };
      const epoch = current.generation;
      try {
        let healthy = false;
        const completed = await bounded(Promise.resolve().then(async () => { healthy = await options.check!(); }));
        if (epoch === current.generation && (!completed || !healthy)) update("failed", completed ? "health_failed" : "timeout");
      } catch {
        if (epoch === current.generation) update("failed", "health_failed");
      }
      return { ...current };
    },
  };
}
