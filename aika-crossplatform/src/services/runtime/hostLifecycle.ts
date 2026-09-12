/**
 * 宿主存活状态（RT-01-D）。
 *
 * 桌面关掉 WebView 不意味着 TS Runtime 还活着；反过来宿主进程活着才有编排。
 * 这个端口把「宿主在线吗」变成**可观测**的三态：online / offline / recovering。
 * 它只描述本进程：宿主死了就是 offline，**不宣称云端接管**。
 *
 * 心跳/租约是可注入的：生产由宿主定时喂 `markAlive()`，测试用假定时器驱动。
 * 离线的判定是租约过期（超时没喂），恢复是重新喂到之后的确认窗口——
 * 「刚喂了一口」不等于「稳定在线」，所以有 recovering 这个中间态。
 */

export type HostLivenessState = "online" | "offline" | "recovering";

export interface HostTimers {
  set(handler: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface HostLifecycleOptions {
  /** 租约时长：超过这么久没喂 markAlive() 就判 offline。 */
  leaseMs?: number;
  /** 恢复确认窗口：重新喂到之后保持 recovering 的时长。默认 leaseMs 的四分之一。 */
  recoveringMs?: number;
  /** 宿主 epoch；默认启动时生成。重启宿主必然换 epoch。 */
  epoch?: string;
  clock?: () => number;
  timers?: HostTimers;
  idFactory?: () => string;
}

export interface HostLifecycle {
  /** 宿主 epoch：同一存活期恒定；重启后是新值。 */
  epoch(): string;
  state(): HostLivenessState;
  /** 心跳：宿主证明自己活着。离线后调用会先进入 recovering。 */
  markAlive(): void;
  /** 宿主主动下线（关闭）：立即 offline，不等租约过期。 */
  markStopping(): void;
  subscribe(listener: (state: HostLivenessState) => void): () => void;
  dispose(): void;
}

export function createHostLifecycle(options: HostLifecycleOptions = {}): HostLifecycle {
  const clock = options.clock ?? (() => Date.now());
  const timers = options.timers ?? {
    set: (handler: () => void, ms: number) => setTimeout(handler, ms),
    clear: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  const idFactory = options.idFactory ?? defaultIdFactory;
  const leaseMs = Math.max(1, options.leaseMs ?? 15_000);
  const recoveringMs = Math.max(1, options.recoveringMs ?? Math.floor(leaseMs / 4));
  const epochValue = options.epoch ?? idFactory();

  const listeners = new Set<(state: HostLivenessState) => void>();
  let state: HostLivenessState = "online";
  let lastAliveAt = clock();
  let leaseTimer: unknown = null;
  let recoveringTimer: unknown = null;
  let disposed = false;

  function setState(next: HostLivenessState): void {
    if (state === next) return;
    state = next;
    for (const listener of [...listeners]) {
      try {
        listener(next);
      } catch {
        // 订阅者抛错不影响状态机。
      }
    }
  }

  function clearTimers(): void {
    if (leaseTimer !== null) {
      timers.clear(leaseTimer);
      leaseTimer = null;
    }
    if (recoveringTimer !== null) {
      timers.clear(recoveringTimer);
      recoveringTimer = null;
    }
  }

  function armLeaseTimer(): void {
    if (leaseTimer !== null) timers.clear(leaseTimer);
    leaseTimer = timers.set(() => {
      leaseTimer = null;
      if (disposed) return;
      // 租约到期：宿主可能已经死了。如实 offline，不猜它还活着。
      setState("offline");
    }, leaseMs);
  }

  armLeaseTimer();

  return {
    epoch: () => epochValue,

    state: () => state,

    markAlive() {
      if (disposed) return;
      lastAliveAt = clock();
      clearTimers();
      if (state === "offline") {
        // 刚恢复：确认窗口内是 recovering，窗口内没有再次过期才回 online。
        setState("recovering");
        recoveringTimer = timers.set(() => {
          recoveringTimer = null;
          if (disposed) return;
          if (clock() - lastAliveAt < leaseMs) setState("online");
        }, recoveringMs);
        armLeaseTimer();
        return;
      }
      armLeaseTimer();
      setState("online");
    },

    markStopping() {
      if (disposed) return;
      clearTimers();
      setState("offline");
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    dispose() {
      disposed = true;
      clearTimers();
      listeners.clear();
    },
  };
}

function defaultIdFactory(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `epoch-${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`;
}
