import type { Clock } from "../time/tokens";
import {
  ENVIRONMENT_SCHEMA_VERSION,
  type EnvironmentEvent,
  type EnvironmentEventInput,
} from "../../domain/environment";
import type {
  EnvironmentMonitor,
  EnvironmentSnapshot,
  EnvironmentSource,
  ProactiveDecision,
  ProactivePolicy,
  ProactivePolicyInput,
} from "./contracts";

/**
 * 测试资产（FE-18）。
 *
 * **fake 只替代外部依赖**：传感器是宿主能力，fake source 替代它天经地义；
 * 但被验收的生产 monitor/摘要出口不允许有 fake 版本——conformance 用例包只
 * 在「生产 monitor + fake source + 假时钟」这一种组合上跑。
 */

/** 手动推进的时钟：去重/频控/TTL 全是惰性计算，不需要真实等待。 */
export function createManualClock(startAt = 0): Clock & { advance(ms: number): void } {
  let now = startAt;
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
  };
}

export type FakeStopBehavior = "ok" | "fail";

export interface FakeEnvironmentSource extends EnvironmentSource {
  readonly id: string;
  readonly kind: string;
  /** start 调用次数；与 stop 次数对照验证资源不泄漏。 */
  readonly startCount: number;
  readonly stopCount: number;
  /** 手动放行挂起的 start（resolve 为停止函数）。 */
  resolveStart(): void;
  rejectStart(error: unknown): void;
  /** 用当前（最新一次 start）注册的 emit 回调提交原始事件；畸形输入原样上交。 */
  emit(raw: EnvironmentEventInput): void;
  /** 用指定次序的 start 回调提交事件：模拟旧 generation 的迟到 emit。 */
  emitViaStart(index: number, raw: EnvironmentEventInput): void;
  setStopBehavior(behavior: FakeStopBehavior): void;
}

export interface FakeEnvironmentSourceOptions {
  id?: string;
  kind?: string;
  /** abort 时是否自动 settle 挂起的 start（模拟守约的 source）。默认 true。 */
  autoSettleOnAbort?: boolean;
  /**
   * start 是否保持挂起等待手动放行。conformance 的生命周期用例需要 true；
   * 编排层测试（presenter 等）传 false 即「立即就绪」。
   */
  deferred?: boolean;
}

export function createFakeEnvironmentSource(
  options: FakeEnvironmentSourceOptions = {},
): FakeEnvironmentSource {
  const id = options.id ?? "fake";
  const autoSettle = options.autoSettleOnAbort ?? true;
  const deferred = options.deferred ?? true;
  const emitters: Array<(event: EnvironmentEventInput) => void> = [];
  let startCount = 0;
  let stopCount = 0;
  let stopBehavior: FakeStopBehavior = "ok";
  let pending: {
    resolve: (stop: () => Promise<void>) => void;
    reject: (error: unknown) => void;
  } | null = null;
  // resolveStart/rejectStart 可在 start() 被调用前排队（monitor 的启动走微任务链，
  // 测试不应依赖微任务时序）。
  let queued: { kind: "resolve" } | { kind: "reject"; error: unknown } | null = null;

  const stopImpl = (): Promise<void> => {
    stopCount += 1;
    if (stopBehavior === "fail") return Promise.reject(new Error("fake stop failure"));
    return Promise.resolve();
  };

  return {
    id,
    kind: options.kind ?? "fake",
    get startCount() {
      return startCount;
    },
    get stopCount() {
      return stopCount;
    },
    start(emit: (event: EnvironmentEventInput) => void, signal: AbortSignal): Promise<() => Promise<void>> {
      startCount += 1;
      emitters.push(emit);
      if (!deferred) {
        // 立即就绪：abort 已发生时也先 resolve，monitor 的迟到路径会调用 stop。
        if (signal.aborted) return Promise.resolve(stopImpl);
        return Promise.resolve(stopImpl);
      }
      return new Promise((resolve, reject) => {
        const settleNow = () => {
          if (!queued) {
            pending = { resolve, reject };
            return;
          }
          const request = queued;
          queued = null;
          if (request.kind === "resolve") resolve(stopImpl);
          else reject(request.error);
        };
        if (autoSettle && signal.aborted) {
          resolve(stopImpl);
          return;
        }
        settleNow();
        if (autoSettle) {
          signal.addEventListener("abort", () => {
            if (pending) {
              const settle = pending;
              pending = null;
              settle.resolve(stopImpl);
            }
          }, { once: true });
        }
      });
    },
    resolveStart() {
      if (pending) {
        const settle = pending;
        pending = null;
        settle.resolve(stopImpl);
        return;
      }
      queued = { kind: "resolve" };
    },
    rejectStart(error) {
      if (pending) {
        const settle = pending;
        pending = null;
        settle.reject(error);
        return;
      }
      queued = { kind: "reject", error };
    },
    emit(raw) {
      const emit = emitters[emitters.length - 1];
      if (emit) emit(raw);
    },
    emitViaStart(index, raw) {
      const emit = emitters[index];
      if (emit) emit(raw);
    },
    setStopBehavior(behavior) {
      stopBehavior = behavior;
    },
  };
}

/** FE-18-E：默认策略对五种 kind 全部 ignore 且带 reason；纯函数，同输入同输出。 */
export function createIgnoreAllPolicy(): ProactivePolicy {
  return {
    evaluate(input: ProactivePolicyInput): ProactiveDecision {
      return { action: "ignore", reason: `default-policy:${input.event.payload.kind}` };
    },
  };
}

export interface FakeEnvironmentMonitor extends EnvironmentMonitor {
  /** 绕过 monitor 机制直接广播（consumer 测试用）；事件原样下发。 */
  emit(event: EnvironmentEvent): void;
  setSnapshot(snapshot: EnvironmentSnapshot): void;
}

/**
 * 手动 emit 的 fake monitor：给 FE-19/22 的消费者测试用，不参与 monitor 验收
 * （那是 environment.conformance 的职责）。
 */
export function createFakeEnvironmentMonitor(): FakeEnvironmentMonitor {
  const subscribers = new Set<(event: EnvironmentEvent) => void>();
  const stateListeners = new Set<() => void>();
  let snapshot: EnvironmentSnapshot = { foreground: null };
  let disposed = false;
  return {
    get snapshot() {
      return snapshot;
    },
    emit(event) {
      for (const listener of [...subscribers]) listener(event);
    },
    setSnapshot(next) {
      snapshot = next;
      for (const listener of [...stateListeners]) listener();
    },
    subscribe(listener) {
      if (disposed) return () => undefined;
      subscribers.add(listener);
      return () => {
        subscribers.delete(listener);
      };
    },
    onStateChange(listener) {
      if (disposed) return () => undefined;
      stateListeners.add(listener);
      return () => {
        stateListeners.delete(listener);
      };
    },
    async setSourceEnabled() {
      if (disposed) throw new Error("disposed");
    },
    async stopAll() {},
    statuses() {
      return [];
    },
    recent() {
      return [];
    },
    diagnostics() {
      return {
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
    },
    async dispose() {
      disposed = true;
      subscribers.clear();
      stateListeners.clear();
    },
  };
}

/** 快速构造一条能通过 schema 防御的事件输入。 */
export function fakeEventInput(overrides: Partial<EnvironmentEventInput> & {
  payload: EnvironmentEventInput["payload"];
  sourceId: string;
  hostEpoch?: string;
}): EnvironmentEventInput {
  return {
    schemaVersion: ENVIRONMENT_SCHEMA_VERSION,
    eventId: `evt-${Math.random().toString(16).slice(2)}`,
    hostEpoch: "test-epoch",
    timestamp: 1_000,
    timingPrecision: "measured",
    confidence: 1,
    ...overrides,
  };
}
