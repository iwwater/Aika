import type { Clock } from "../time/tokens";
import {
  ENVIRONMENT_SCHEMA_VERSION,
  eventRuleId,
  normalizeEnvironmentEvent,
  type EnvironmentEvent,
  type EnvironmentEventInput,
  type EnvironmentEventKind,
  type EnvironmentEventRejectReason,
} from "../../domain/environment";
import {
  EnvironmentMonitorError,
  EnvironmentSourceError,
  type EnvironmentMonitor,
  type EnvironmentMonitorDiagnostics,
  type EnvironmentForegroundState,
  type EnvironmentRecentEntry,
  type EnvironmentSnapshot,
  type EnvironmentSource,
  type EnvironmentSourceErrorCode,
  type EnvironmentSourceState,
  type EnvironmentSourceStatus,
} from "./contracts";

/**
 * 生产 EnvironmentMonitor（FE-18）。
 *
 * 职责边界：
 * - schema 防御与自由文本剥离（domain/environment.ts 的规范化入口）；
 * - 去重、频控、recent（TTL 60s、上限 20）、前台快照；
 * - source 生命周期（off/starting/running/stopping/denied/error + generation 撤销，
 *   start/stop 逐源串行化，stopAll 先撤销后等待）。
 *
 * 明确不做：不做设置开关 UI（FE-19）、不做策略接线（FE-22）、不起任何定时器——
 * 所有窗口语义都是读取时刻的惰性计算，测试用假时钟推进即可，不需要真实等待。
 */

export const DEFAULT_DEDUPE_WINDOW_MS = 2000;
export const DEFAULT_MAX_PER_MINUTE = 60;
export const DEFAULT_RECENT_TTL_MS = 60_000;
export const DEFAULT_RECENT_LIMIT = 20;

/** 频控滚动窗口：与「每分钟」语义一致，独立于 recent 的 TTL。 */
const RATE_WINDOW_MS = 60_000;

export interface EnvironmentMonitorOptions {
  /** monitor 可信时间基准：去重、频控、TTL、时长全部用它，不用可回拨墙钟。 */
  clock: Clock;
  /**
   * 事件归属的宿主 epoch。来源事件 hostEpoch 不一致视为旧会话残余并丢弃。
   * 生产装配传宿主 lifecycle 的 epoch；缺省时 monitor 自造一个（多宿主测试各得其所）。
   */
  hostEpoch?: string;
  /** 墙钟基准，只用于「未来时间」诊断；不传则跳过该检查（不跨时钟比较）。 */
  wallClock?: Clock;
  dedupeWindowMs?: number;
  maxPerMinute?: number;
  recentTtlMs?: number;
  recentLimit?: number;
}

interface SourceRuntime {
  readonly definition: EnvironmentSource;
  state: EnvironmentSourceState;
  generation: number;
  /** 当前允许广播的 generation；null = 已撤销（stopAll / stop 之后零广播）。 */
  liveGeneration: number | null;
  stopFn: (() => Promise<void>) | null;
  abort: AbortController | null;
  /** start/stop 逐源串行化链。 */
  chain: Promise<void>;
  error: EnvironmentSourceErrorCode | null;
  recent: EnvironmentRecentEntry[];
  dedupeKeys: Map<string, number>;
  rateWindow: number[];
  /** 前台快照是否由该 source 持有（关闭/出错时随之失效）。 */
  ownsForeground: boolean;
}

function frozenStatus(runtime: SourceRuntime): EnvironmentSourceStatus {
  return Object.freeze({
    sourceId: runtime.definition.id,
    state: runtime.state,
    generation: runtime.generation,
    error: runtime.error,
  });
}

export function createEnvironmentMonitor(
  sources: readonly EnvironmentSource[],
  options: EnvironmentMonitorOptions,
): EnvironmentMonitor {
  const clock = options.clock;
  const wallClock = options.wallClock;
  const hostEpoch = options.hostEpoch ?? `monitor-${Math.random().toString(16).slice(2)}`;
  const dedupeWindowMs = options.dedupeWindowMs ?? DEFAULT_DEDUPE_WINDOW_MS;
  const maxPerMinute = options.maxPerMinute ?? DEFAULT_MAX_PER_MINUTE;
  const recentTtlMs = options.recentTtlMs ?? DEFAULT_RECENT_TTL_MS;
  const recentLimit = options.recentLimit ?? DEFAULT_RECENT_LIMIT;

  const runtimes = new Map<string, SourceRuntime>();
  for (const definition of sources) {
    runtimes.set(definition.id, {
      definition,
      state: "off",
      generation: 0,
      liveGeneration: null,
      stopFn: null,
      abort: null,
      chain: Promise.resolve(),
      error: null,
      recent: [],
      dedupeKeys: new Map(),
      rateWindow: [],
      ownsForeground: false,
    });
  }

  const subscribers = new Set<(event: EnvironmentEvent) => void>();
  const stateListeners = new Set<() => void>();

  const counters: {
    schemaRejected: number;
    staleEpochRejected: number;
    staleGenerationDropped: number;
    dedupeDropped: number;
    rateLimitedDropped: number;
    futureTimestampRejected: number;
    sourceStartFailed: number;
    sourceStopFailed: number;
    listenerErrors: number;
    internalErrors: number;
  } = {
    schemaRejected: 0,
    staleEpochRejected: 0,
    staleGenerationDropped: 0,
    dedupeDropped: 0,
    rateLimitedDropped: 0,
    futureTimestampRejected: 0,
    sourceStartFailed: 0,
    sourceStopFailed: 0,
    listenerErrors: 0,
    internalErrors: 0,
  };

  let disposed = false;
  let foreground: EnvironmentForegroundState | null = null;

  function notifyStateChange(): void {
    for (const listener of [...stateListeners]) {
      try {
        listener();
      } catch {
        counters.listenerErrors += 1;
      }
    }
  }

  function clearForeground(owner?: SourceRuntime): void {
    if (foreground === null) return;
    if (owner && !owner.ownsForeground) return;
    foreground = null;
    if (owner) owner.ownsForeground = false;
    notifyStateChange();
  }

  const rejectReasonCounter: Partial<Record<EnvironmentEventRejectReason, keyof typeof counters>> = {
    future_timestamp: "futureTimestampRejected",
  };
  function countReject(reason: EnvironmentEventRejectReason): void {
    const mapped = rejectReasonCounter[reason];
    if (mapped) counters[mapped] += 1;
    else counters.schemaRejected += 1;
  }

  function broadcast(event: EnvironmentEvent): void {
    for (const listener of [...subscribers]) {
      try {
        listener(event);
      } catch {
        counters.listenerErrors += 1;
      }
    }
  }

  function recordRecent(runtime: SourceRuntime, event: EnvironmentEvent): void {
    runtime.recent.push(Object.freeze({
      sourceId: event.sourceId,
      kind: event.payload.kind,
      ruleId: eventRuleId(event.payload),
      process: event.payload.kind === "foreground_changed" ? event.payload.process : null,
      confidence: event.confidence,
      receivedMonotonicMs: event.receivedMonotonicMs,
    }));
    if (runtime.recent.length > recentLimit) runtime.recent.splice(0, runtime.recent.length - recentLimit);
  }

  /** 规范化之后的准入与分发。调用方已校验 generation/state，不再重复。 */
  function ingest(runtime: SourceRuntime, raw: EnvironmentEventInput): void {
    const normalized = normalizeEnvironmentEvent(raw, {
      sourceId: runtime.definition.id,
      receivedMonotonicMs: clock.now(),
      nowWallMs: wallClock?.now(),
    });
    if (!normalized.ok) {
      countReject(normalized.reason);
      return;
    }
    const event = normalized.event;
    if (event.hostEpoch !== hostEpoch) {
      counters.staleEpochRejected += 1;
      return;
    }

    // 前台快照是「单独状态」：即使事件被去重/限流（广播省略），最新状态也要落地，
    // 否则 A→B→A 快速切换会把快照留在错误的 B 上。
    if (event.payload.kind === "foreground_changed") {
      foreground = Object.freeze({ process: event.payload.process, since: event.receivedMonotonicMs });
      runtime.ownsForeground = true;
      notifyStateChange();
    }

    const payloadKey = `${event.sourceId}:${JSON.stringify(event.payload)}`;
    const lastAccepted = runtime.dedupeKeys.get(payloadKey);
    if (lastAccepted !== undefined && event.receivedMonotonicMs - lastAccepted < dedupeWindowMs) {
      counters.dedupeDropped += 1;
      return;
    }

    runtime.rateWindow = runtime.rateWindow.filter(
      (at) => event.receivedMonotonicMs - at < RATE_WINDOW_MS,
    );
    if (runtime.rateWindow.length >= maxPerMinute) {
      counters.rateLimitedDropped += 1;
      return;
    }

    runtime.dedupeKeys.set(payloadKey, event.receivedMonotonicMs);
    runtime.rateWindow.push(event.receivedMonotonicMs);
    recordRecent(runtime, event);
    broadcast(event);
  }

  function emitFor(runtime: SourceRuntime, generation: number): (raw: EnvironmentEventInput) => void {
    return (raw) => {
      try {
        if (disposed) return;
        // 迟到的 emit：generation 已被撤销、或 start 尚未就绪——一律静默丢弃。
        if (runtime.liveGeneration !== generation || runtime.state !== "running") {
          counters.staleGenerationDropped += 1;
          return;
        }
        ingest(runtime, raw);
      } catch {
        // 单 source 的 emit 抛错被吞掉并计数；其他 source 与订阅者不受影响。
        counters.internalErrors += 1;
      }
    };
  }

  /**
   * 实际启动（经逐源串行链执行）。
   *
   * generation 与 abort controller 在 setSourceEnabled 里同步分配——状态转移
   * starting 同步可见，停止请求不需要等微任务才能被识别。
   */
  async function startSource(runtime: SourceRuntime, abort: AbortController): Promise<void> {
    const generation = runtime.generation;
    let stopFn: (() => Promise<void>) | null = null;
    try {
      stopFn = await runtime.definition.start(emitFor(runtime, generation), abort.signal);
    } catch (error) {
      runtime.abort = null;
      if (abort.signal.aborted) {
        // 停止请求发生在 ready 前：这次启动作废，不进入 error。
        runtime.state = "off";
        notifyStateChange();
        return;
      }
      const code = error instanceof EnvironmentSourceError ? error.code : "start_failed";
      runtime.state = code === "denied" ? "denied" : "error";
      runtime.error = code;
      counters.sourceStartFailed += 1;
      notifyStateChange();
      return;
    }

    // 迟到就绪：abort 已发生（或已 dispose）时，返回的 stop 也必须执行。
    if (abort.signal.aborted || disposed) {
      runtime.abort = null;
      try {
        await stopFn();
      } catch {
        counters.sourceStopFailed += 1;
        runtime.state = "error";
        runtime.error = "stop_failed";
        notifyStateChange();
        return;
      }
      runtime.state = "off";
      runtime.error = null;
      notifyStateChange();
      return;
    }

    runtime.abort = null;
    runtime.stopFn = stopFn;
    runtime.liveGeneration = generation;
    runtime.state = "running";
    notifyStateChange();
  }

  /**
   * 收尾停止（经逐源串行链执行）。
   *
   * abort 与 generation 撤销已在请求停止时同步完成；这里只等待停止函数并落终态。
   * start 尚未就绪的场合，startSource 的迟到就绪路径会调用返回的 stop——
   * 本函数到链上运行时它已经结束（state=off），这里按幂等直接返回。
   */
  async function finishStop(runtime: SourceRuntime): Promise<void> {
    if (runtime.state === "off") return;
    const stopFn = runtime.stopFn;
    runtime.stopFn = null;
    runtime.abort = null;
    if (stopFn) {
      try {
        await stopFn();
      } catch {
        counters.sourceStopFailed += 1;
        runtime.state = "error";
        runtime.error = "stop_failed";
        clearRuntimeState(runtime);
        notifyStateChange();
        return;
      }
    }
    runtime.state = "off";
    runtime.error = null;
    clearRuntimeState(runtime);
    notifyStateChange();
  }

  /** 关闭只清除该 source 自己的状态与 recent；前台快照若由它持有则一并失效。 */
  function clearRuntimeState(runtime: SourceRuntime): void {
    runtime.recent = [];
    runtime.dedupeKeys.clear();
    runtime.rateWindow = [];
    if (runtime.ownsForeground) clearForeground(runtime);
  }

  const monitor: EnvironmentMonitor = {
    get snapshot(): EnvironmentSnapshot {
      return { foreground };
    },

    subscribe(listener: (event: EnvironmentEvent) => void): () => void {
      if (disposed) return () => undefined;
      subscribers.add(listener);
      return () => {
        subscribers.delete(listener);
      };
    },

    onStateChange(listener: () => void): () => void {
      if (disposed) return () => undefined;
      stateListeners.add(listener);
      return () => {
        stateListeners.delete(listener);
      };
    },

    async setSourceEnabled(sourceId: string, enabled: boolean): Promise<void> {
      if (disposed) throw new EnvironmentMonitorError("disposed");
      const runtime = runtimes.get(sourceId);
      if (!runtime) throw new EnvironmentMonitorError("unknown_source", `unknown source: ${sourceId}`);
      if (enabled) {
        if (runtime.state === "running" || runtime.state === "starting") return;
        // 状态转移同步可见：starting 立刻成立，停止请求不用等微任务。
        runtime.state = "starting";
        runtime.generation += 1;
        runtime.error = null;
        runtime.liveGeneration = null;
        runtime.stopFn = null;
        const abort = new AbortController();
        runtime.abort = abort;
        notifyStateChange();
        runtime.chain = runtime.chain.then(() => startSource(runtime, abort));
        await runtime.chain;
        return;
      }
      if (runtime.state === "off" || runtime.state === "stopping") return;
      // 立即撤销 + abort：从这里开始旧 generation 零广播，即使 start 尚未返回。
      runtime.state = "stopping";
      runtime.liveGeneration = null;
      runtime.abort?.abort();
      notifyStateChange();
      runtime.chain = runtime.chain.then(() => finishStop(runtime));
      await runtime.chain;
    },

    async stopAll(): Promise<void> {
      if (disposed) return;
      // 先撤销全部 generation：从这里开始旧回调零广播，然后才清快照/recent、等停止。
      for (const runtime of runtimes.values()) {
        runtime.liveGeneration = null;
        if (runtime.state !== "off") {
          runtime.state = "stopping";
          runtime.abort?.abort();
        }
        clearRuntimeState(runtime);
      }
      if (foreground !== null) {
        foreground = null;
        notifyStateChange();
      }
      await Promise.all([...runtimes.values()].map((runtime) => {
        if (runtime.state === "off") return Promise.resolve();
        runtime.chain = runtime.chain.then(() => finishStop(runtime));
        return runtime.chain;
      }));
    },

    statuses(): readonly EnvironmentSourceStatus[] {
      return [...runtimes.values()].map(frozenStatus);
    },

    recent(): readonly EnvironmentRecentEntry[] {
      const now = clock.now();
      const entries: EnvironmentRecentEntry[] = [];
      for (const runtime of runtimes.values()) {
        runtime.recent = runtime.recent.filter(
          (entry) => now - entry.receivedMonotonicMs < recentTtlMs,
        );
        entries.push(...runtime.recent);
      }
      entries.sort((a, b) => a.receivedMonotonicMs - b.receivedMonotonicMs);
      return entries;
    },

    diagnostics(): EnvironmentMonitorDiagnostics {
      return Object.freeze({ ...counters });
    },

    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      await monitor.stopAll();
      subscribers.clear();
      stateListeners.clear();
    },
  };

  return monitor;
}

/** recent 条目的 kind 词汇表再导出，方便消费方做穷举。 */
export type EnvironmentRecentKind = EnvironmentEventKind;
export const ENVIRONMENT_EVENT_SCHEMA_VERSION = ENVIRONMENT_SCHEMA_VERSION;
