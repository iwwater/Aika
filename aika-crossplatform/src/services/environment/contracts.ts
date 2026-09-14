import { token } from "../../kernel";
import type { EnvironmentEvent, EnvironmentEventInput } from "../../domain/environment";

/**
 * 环境感知端口（FE-18）。
 *
 * 环境感知的全部真实传感器都是宿主能力（Rust/Win32）。TS 侧只认这里的事件契约
 * 与策略端口，之后每个传感器 SPEC（FE-19/21）只交付「多一个 EnvironmentSource
 * 实现」，不再动契约。
 *
 * 「能力缺失即 token 不注册」在这里的用法：宿主没有可用传感器时根本不注册
 * `EnvironmentSourcesToken`（也不构造 environmentPlugin 的 monitor 部分），消费方
 * optional + tryResolve 拿到 null 就降级，不弹错、不阻断启动。
 */

/** 一个传感器实现。start 在就绪后 resolve，返回幂等的异步停止函数。 */
export interface EnvironmentSource {
  /** 稳定身份：事件 sourceId 的打点依据与状态/去重的键。 */
  readonly id: string;
  /** "foreground" | "screen" | … 传感器种类标识。 */
  readonly kind: string;
  /**
   * 启动采集。
   *
   * `emit` 只在就绪后调用；`signal` abort 后必须尽快 settle 返回的 Promise——
   * 若 start 在 abort 之后才 resolve（迟到就绪），monitor 会立即调用返回的
   * 停止函数并丢弃该次启动。停止函数必须幂等。
   */
  start(emit: (event: EnvironmentEventInput) => void, signal: AbortSignal): Promise<() => Promise<void>>;
}

/** 当前前台应用状态。`since` 是 monitor 单调时钟毫秒；标题不在这里（不采集）。 */
export interface EnvironmentForegroundState {
  readonly process: string;
  readonly since: number;
}

export interface EnvironmentSnapshot {
  readonly foreground: EnvironmentForegroundState | null;
}

/** source 生命周期（2026-09-14 修订）。generation 每次 start 递增，用于撤销。 */
export type EnvironmentSourceState = "off" | "starting" | "running" | "stopping" | "denied" | "error";

/** 错误只含代码，不含正文——传感器内部信息不出现在状态里。 */
export type EnvironmentSourceErrorCode =
  | "denied"
  | "unavailable"
  | "start_failed"
  | "stop_failed";

export class EnvironmentSourceError extends Error {
  constructor(readonly code: EnvironmentSourceErrorCode, message?: string) {
    super(message ?? code);
    this.name = "EnvironmentSourceError";
  }
}

export interface EnvironmentSourceStatus {
  readonly sourceId: string;
  readonly state: EnvironmentSourceState;
  readonly generation: number;
  readonly error: EnvironmentSourceErrorCode | null;
}

/** 规范化后的 recent 条目：只存受控摘要（kind / 词表 ID / 置信度 / 接收时间）。 */
export interface EnvironmentRecentEntry {
  readonly sourceId: string;
  readonly kind: EnvironmentEvent["payload"]["kind"];
  /** screen_keyword / game_event 的词表 ID；其他 kind 为 null。 */
  readonly ruleId: string | null;
  /** foreground_changed 的受控进程名；其他 kind 为 null。 */
  readonly process: string | null;
  readonly confidence: number;
  readonly receivedMonotonicMs: number;
}

export interface EnvironmentMonitorDiagnostics {
  readonly schemaRejected: number;
  readonly staleEpochRejected: number;
  readonly staleGenerationDropped: number;
  readonly dedupeDropped: number;
  readonly rateLimitedDropped: number;
  readonly futureTimestampRejected: number;
  readonly sourceStartFailed: number;
  readonly sourceStopFailed: number;
  readonly listenerErrors: number;
  readonly internalErrors: number;
}

export type EnvironmentMonitorErrorCode = "unknown_source" | "disposed";

export class EnvironmentMonitorError extends Error {
  constructor(readonly code: EnvironmentMonitorErrorCode, message?: string) {
    super(message ?? code);
    this.name = "EnvironmentMonitorError";
  }
}

export interface EnvironmentMonitor {
  /** 注册 monitor ≠ 启动 source：所有 source 初始为 off，由控制端口接入（FE-19）。 */
  readonly snapshot: EnvironmentSnapshot;
  /** 订阅规范化后的事件流；返回退订函数。monitor dispose 后订阅得到 no-op。 */
  subscribe(listener: (event: EnvironmentEvent) => void): () => void;
  /** 快照/状态变化通知（FE-19 presenter 的状态订阅依据）；不携带数据，读 getter。 */
  onStateChange(listener: () => void): () => void;
  /** 启停单个 source；start/stop 逐源串行化。未知 sourceId 抛 unknown_source。 */
  setSourceEnabled(sourceId: string, enabled: boolean): Promise<void>;
  /** 先撤销全部 generation、清空 snapshot/recent，再等待全部 stop；单源失败不阻断其余。 */
  stopAll(): Promise<void>;
  statuses(): readonly EnvironmentSourceStatus[];
  /** TTL 内的 recent 摘要（跨 source，按接收时间升序）。过期条目惰性剔除。 */
  recent(): readonly EnvironmentRecentEntry[];
  diagnostics(): EnvironmentMonitorDiagnostics;
  /** 幂等；等待全部 stop 完成后不再广播，订阅与状态监听全部解除。 */
  dispose(): Promise<void>;
}

/**
 * 纯策略：只回答「这个事件值不值得说」，不写存储、不发请求、不起定时器。
 * 「现在能不能说」由既有 canSend 闸门终审（FE-22 接线）。
 */
export interface ProactivePolicyInput {
  event: EnvironmentEvent;
  /** monitor/宿主单调时钟的当前值。 */
  now: number;
  lastSentAt: number | null;
  /** countProactiveSince(startOfToday)，拿不到为 null。 */
  proactiveToday: number | null;
  /** null 为无法判定；不从进程名伪推全屏（2026-09-14 修订）。 */
  userBusy: boolean | null;
  sustainedMs: number;
  occurrencesInWindow: number;
}

export type ProactiveDecision =
  | { action: "ignore"; reason: string }
  | { action: "remember"; reason: string }
  | { action: "trigger"; reason: string };

export interface ProactivePolicy {
  /** 同输入同输出；禁止隐藏全局可变计数。 */
  evaluate(input: ProactivePolicyInput): ProactiveDecision;
}

/** 宿主发布它探测到的传感器集合；无能力时不注册（缺失是常态）。 */
export const EnvironmentSourcesToken = token<readonly EnvironmentSource[]>("environment.sources");
/**
 * 统一 capture/OCR 调度器（FE-32）。词表轨与全文读屏**共用同一个实例**，
 * 这样「每分钟 10 次」才是一份总额而不是两份。宿主没有屏幕能力时不注册。
 */
export const CaptureSchedulerToken = token<import("./captureScheduler").CaptureScheduler>("environment.captureScheduler");
/** 按需读屏上下文源（FE-32）；宿主没有屏幕能力时不注册。 */
export const ScreenContextSourceToken = token<import("./screenContextSource").ScreenContextSource>("environment.screenContext");
export const EnvironmentMonitorToken = token<EnvironmentMonitor>("environment.monitor");
export const ProactivePolicyToken = token<ProactivePolicy>("environment.proactivePolicy");
