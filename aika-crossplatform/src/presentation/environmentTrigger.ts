import type { Clock } from "../services/time/tokens";
import type { EnvironmentEvent } from "../domain/environment";
import type { ProactiveReasonKind } from "../domain/proactive";
import type {
  EnvironmentMonitor,
  ProactiveDecision,
  ProactivePolicy,
} from "../services/environment/contracts";
import { eventAggregationKey } from "../services/environment/ruleProactivePolicy";
import {
  readBusyObservation,
  type BusyObserver,
  type BusyReading,
} from "../services/environment/busySource";
import { eventRuleId } from "../domain/environment";

/**
 * 环境事件 → 主动发送的触发器（FE-22）。
 *
 * 职责：订阅 monitor → 聚合 remember 环形缓冲（≤20、TTL 60s、只存受控摘要）→
 * ProactivePolicy 裁决 → 终门禁（三开关 + source running + 摘要 TTL + busy 观测）
 * → 经共享发送预约进入既有主动发送路径（presenter 注入 attemptSend）。
 *
 * 红线：
 * - 忙碌未知（无观测/过期/null）一律不发送（PRO-04）。
 * - **锁屏一律不发送**（MVP-04 AC-B）：宿主把锁定与全屏分开报，锁屏时用户不在
 *   桌面前，谈不上「一起看看」，同时清空缓冲——否则解锁后会带着锁屏期间累计的
 *   「持续时长」补一轮。全屏是另一回事：那是玩游戏，结算类候选照常（FE-22 冻结语义）。
 * - 摘要年龄 ≥60000ms 的过期事件不作为触发依据（TTL 边界由门禁复核）。
 * - reason/请求内容只引用词表 ID，OCR 原文永不进入。
 * - 关闭（source off / stopAll / dispose）清空缓冲；缓冲是易失的，不写长期记忆。
 */

export const ENVIRONMENT_SUMMARY_TTL_MS = 60_000;
export const ENVIRONMENT_BUFFER_LIMIT = 20;
export const BUSY_MAX_AGE_MS = 2000;

export interface EnvironmentTriggerDeps {
  monitor: EnvironmentMonitor;
  policy: ProactivePolicy;
  /** 可信 busy 观测；null = 本宿主无观测能力 → 永远 unknown，不发。 */
  busy: BusyObserver | null;
  clock: Clock;
  gates: {
    globalProactive(): Promise<boolean>;
    environmentProactive(): Promise<boolean>;
    contextEnabled(): Promise<boolean>;
    /** canSend 终审（勿扰/每日上限/最小间隔）。 */
    canSend(): Promise<boolean>;
  };
  /**
   * 既有发送路径（presenter 注入）：内部取得共享发送预约、构建 reason、
   * sendTurn(…, "proactive")、持久化与通知。resolve true = submit 成功。
   */
  attemptSend(event: EnvironmentEvent, reasonKind: ProactiveReasonKind, buffer: readonly string[]): Promise<boolean>;
}

export interface EnvironmentTriggerSnapshot {
  bufferCount: number;
  lastDecision: { eventId: string; action: string; reason: string } | null;
  lastSubmit: { eventId: string; reasonKind: ProactiveReasonKind } | null;
  busyUnknownCount: number;
  gateRejectedCount: number;
}

export interface EnvironmentTrigger {
  start(): void;
  dispose(): void;
  /** 测试与编排入口：处理一条已规范化的事件（与 monitor 订阅同一函数）。 */
  handleEvent(event: EnvironmentEvent): Promise<void>;
  snapshot(): EnvironmentTriggerSnapshot;
  /** 当前 remember 缓冲的受控摘要（词表 ID 列表）。 */
  buffer(): readonly string[];
  clearBuffer(): void;
}

interface RememberEntry {
  key: string;
  ruleId: string | null;
  receivedMonotonicMs: number;
}

export function createEnvironmentTrigger(deps: EnvironmentTriggerDeps): EnvironmentTrigger {
  const buffer: RememberEntry[] = [];
  let started = false;
  let disposed = false;
  let unsubscribeState: (() => void) | null = null;
  let unsubscribeEvents: (() => void) | null = null;
  let lastDecision: EnvironmentTriggerSnapshot["lastDecision"] = null;
  let lastSubmit: EnvironmentTriggerSnapshot["lastSubmit"] = null;
  let busyUnknownCount = 0;
  let gateRejectedCount = 0;

  function clearBuffer(): void {
    buffer.length = 0;
  }

  function record(key: string, ruleId: string | null): void {
    const now = deps.clock.now();
    // TTL 先剔除（缓冲只保留有效窗口内的摘要），再按上限挤出。
    while (buffer.length > 0 && now - buffer[0].receivedMonotonicMs >= ENVIRONMENT_SUMMARY_TTL_MS) {
      buffer.shift();
    }
    buffer.push({ key, ruleId, receivedMonotonicMs: now });
    while (buffer.length > ENVIRONMENT_BUFFER_LIMIT) buffer.shift();
  }

  /** 同 key 在 60s 窗口内的出现次数与最早出现时刻（去重后的生产聚合结果）。 */
  function windowStats(key: string): { occurrences: number; sustainedMs: number } {
    const now = deps.clock.now();
    const inWindow = buffer.filter(
      (entry) => entry.key === key && now - entry.receivedMonotonicMs < ENVIRONMENT_SUMMARY_TTL_MS,
    );
    if (inWindow.length === 0) return { occurrences: 0, sustainedMs: 0 };
    const earliest = Math.min(...inWindow.map((entry) => entry.receivedMonotonicMs));
    return { occurrences: inWindow.length + 1, sustainedMs: now - earliest };
  }

  /** 刷新并读回一次观测；「值是否可用」与「是否锁屏」由共享读法统一判定。 */
  function observeBusy(): Promise<BusyReading> {
    return readBusyObservation(deps.busy, deps.clock, BUSY_MAX_AGE_MS);
  }

  async function runGates(event: EnvironmentEvent): Promise<boolean> {
    const [globalEnabled, environmentEnabled, contextOn] = await Promise.all([
      deps.gates.globalProactive(),
      deps.gates.environmentProactive(),
      deps.gates.contextEnabled(),
    ]);
    if (!globalEnabled || !environmentEnabled || !contextOn) {
      gateRejectedCount += 1;
      return false;
    }
    // source 正运行 + 事件仍在摘要 TTL 内（同 generation 由 monitor 保证）。
    const sourceState = deps.monitor.statuses().find((status) => status.sourceId === event.sourceId)?.state;
    if (sourceState !== "running") {
      gateRejectedCount += 1;
      return false;
    }
    const recent = deps.monitor.recent().find(
      (entry) => entry.sourceId === event.sourceId
        && eventRuleId(event.payload) !== null
        && entry.ruleId === eventRuleId(event.payload)
        && deps.clock.now() - entry.receivedMonotonicMs < ENVIRONMENT_SUMMARY_TTL_MS,
    );
    const isForeground = event.payload.kind === "foreground_changed";
    if (!recent && !isForeground) {
      gateRejectedCount += 1;
      return false;
    }
    return true;
  }

  async function handleEvent(event: EnvironmentEvent): Promise<void> {
    if (disposed || !started) return;

    // 忙碌观测：提交前按需刷新；未知一律不发送。
    const busy = await observeBusy();
    if (busy.value === null) {
      busyUnknownCount += 1;
      lastDecision = { eventId: event.eventId, action: "ignore", reason: "busy-unknown" };
      return;
    }
    // 锁屏：不在桌面前就没什么可说的，且清掉已记住的弱信号（MVP-04 AC-B）。
    if (busy.locked) {
      clearBuffer();
      lastDecision = { eventId: event.eventId, action: "ignore", reason: "session-locked" };
      return;
    }

    const key = eventAggregationKey(event);
    const stats = windowStats(key);
    const decision: ProactiveDecision = deps.policy.evaluate({
      event,
      now: deps.clock.now(),
      lastSentAt: null,
      proactiveToday: null,
      userBusy: busy.value,
      sustainedMs: stats.sustainedMs,
      occurrencesInWindow: stats.occurrences,
    });
    lastDecision = { eventId: event.eventId, action: decision.action, reason: decision.reason };

    if (decision.action === "ignore") return;
    record(key, eventRuleId(event.payload));

    if (decision.action === "remember") return;

    if (!(await runGates(event))) return;
    // 决策后等待过异步门禁：busy 时效与锁屏再复核一次（任何等待后的边界重新验证）。
    const busyRecheck = await observeBusy();
    if (busyRecheck.value === null || busyRecheck.locked) {
      if (busyRecheck.value === null) busyUnknownCount += 1;
      gateRejectedCount += 1;
      return;
    }

    const reasonKind: ProactiveReasonKind = decision.reason.startsWith("game-result:")
      ? "game-result"
      : "environment-weak";
    const bufferSummary = buffer
      .map((entry) => entry.ruleId)
      .filter((ruleId): ruleId is string => ruleId !== null);
    const sent = await deps.attemptSend(event, reasonKind, bufferSummary);
    if (sent) {
      lastSubmit = { eventId: event.eventId, reasonKind };
    }
  }

  return {
    start(): void {
      if (started || disposed) return;
      started = true;
      unsubscribeEvents = deps.monitor.subscribe((event) => {
        void handleEvent(event);
      });
      // source 关闭/stopAll → 清空缓冲（在途候选本来就不存在：发送是同步决策）。
      unsubscribeState = deps.monitor.onStateChange(() => {
        const anyOff = deps.monitor.statuses().some((status) => status.state === "off" || status.state === "error");
        if (anyOff) clearBuffer();
      });
    },

    dispose(): void {
      disposed = true;
      started = false;
      unsubscribeEvents?.();
      unsubscribeEvents = null;
      unsubscribeState?.();
      unsubscribeState = null;
      clearBuffer();
    },

    handleEvent,

    snapshot(): EnvironmentTriggerSnapshot {
      return {
        bufferCount: buffer.length,
        lastDecision,
        lastSubmit,
        busyUnknownCount,
        gateRejectedCount,
      };
    },

    buffer(): readonly string[] {
      return buffer.map((entry) => entry.ruleId ?? entry.key);
    },

    clearBuffer,
  };
}
