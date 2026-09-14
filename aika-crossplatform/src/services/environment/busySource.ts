import type { Clock } from "../time/tokens";

/**
 * 可信 busy 观测（FE-19 2026-09-14 修订第 5/6 条）。
 *
 * `BusyObservation` 只表示「可观测打扰状态」：全屏/锁定 → true，成功观测到
 * 普通可见窗口 → false，其余（无前台、最小化、查询失败、观测过期）→ null。
 * 它不声称知道用户心理或工作强度；**禁止按进程名推定全屏**。
 *
 * 观测有效期 2000ms：过期即 unknown，不拿旧观测当新鲜事实。观测只在对应
 * 传感器开启期间由消费方（FE-22 门禁）触发，本模块自身不启动轮询。
 */

export const BUSY_OBSERVATION_MAX_AGE_MS = 2000;

export interface BusyObservation {
  value: boolean | null;
  observedMonotonicMs: number;
  hostEpoch: string;
  reasonCode: string;
}

/** 宿主 adapter：Rust 实现走 `environment_busy_query`；测试注入固定 fixture。 */
export interface BusyHostAdapter {
  query(): Promise<{ busy: boolean | null; reason: string }>;
}

export interface BusyObserverOptions {
  clock: Clock;
  hostEpoch: string;
  maxAgeMs?: number;
}

export interface BusyObserver {
  /** 主动观测一次并缓存。失败按 unknown 记录（reason=query_failed）。 */
  refresh(): Promise<BusyObservation>;
  /** 读取有效观测；缺失或超过 maxAgeMs 一律 unknown（不产生新查询）。 */
  current(): BusyObservation;
  clear(): void;
}

const UNKNOWN = (reasonCode: string, hostEpoch: string, clock: Clock): BusyObservation => ({
  value: null,
  observedMonotonicMs: clock.now(),
  hostEpoch,
  reasonCode,
});

export function createBusyObserver(
  adapter: BusyHostAdapter,
  options: BusyObserverOptions,
): BusyObserver {
  const maxAgeMs = options.maxAgeMs ?? BUSY_OBSERVATION_MAX_AGE_MS;
  let latest: BusyObservation | null = null;

  return {
    async refresh(): Promise<BusyObservation> {
      const observedMonotonicMs = options.clock.now();
      try {
        const result = await adapter.query();
        const observation: BusyObservation = {
          // 宿主把锁定/失败明确标成 null：unknown 不能被折算成 false。
          value: result.busy === true ? true : result.busy === false ? false : null,
          observedMonotonicMs,
          hostEpoch: options.hostEpoch,
          reasonCode: result.reason || "unknown",
        };
        latest = observation;
        return observation;
      } catch {
        const observation = UNKNOWN("query_failed", options.hostEpoch, options.clock);
        latest = observation;
        return observation;
      }
    },

    current(): BusyObservation {
      if (!latest) return UNKNOWN("no_observation", options.hostEpoch, options.clock);
      const age = options.clock.now() - latest.observedMonotonicMs;
      if (age > maxAgeMs) return UNKNOWN("stale", options.hostEpoch, options.clock);
      return latest;
    },

    clear(): void {
      latest = null;
    },
  };
}

/** Tauri 宿主 adapter。invoke 键 camelCase，与 Rust 命令参数对齐。 */
export function createTauriBusyAdapter(
  invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>,
): BusyHostAdapter {
  return {
    async query() {
      const raw = await invoke("environment_busy_query", {});
      const payload = raw as { busy?: unknown; reason?: unknown } | null;
      if (!payload || typeof payload !== "object") {
        return { busy: null, reason: "malformed" };
      }
      return {
        busy: typeof payload.busy === "boolean" ? payload.busy : null,
        reason: typeof payload.reason === "string" ? payload.reason : "malformed",
      };
    },
  };
}

// token 分散所有权：busy 观测者由宿主装配提供（Rust adapter），消费方 optional。
import { token } from "../../kernel";
export const EnvironmentBusyObserverToken = token<BusyObserver>("environment.busyObserver");

/**
 * Rust `foreground::classify_busy` 的「已锁定」编码（MVP-04）。
 *
 * 宿主把**锁屏**与**全屏**分开报：`session_locked` = 会话已锁定，`fullscreen` =
 * 前台窗口铺满显示器（正常玩游戏）。两者都折算成 `busy=true`，但对「还能不能
 * 自动开口/用旧摘录」是两件事：锁屏时用户不在桌面前，任何观察都无从谈起。
 * 编码字符串由 `src-tauri/src/foreground.rs` 的单测固定，改动需两侧同步。
 */
export const BUSY_REASON_LOCKED = "session_locked";

export interface BusyReading {
  /** true/false = 可信观测；null = 无法判定（无前台/最小化/查询失败/过期/无观测者）。 */
  value: boolean | null;
  /** 观测到「会话已锁定」。无法判定时为 false（此时 value 也是 null）。 */
  locked: boolean;
  reasonCode: string;
}

/**
 * 刷新并读回一次可信观测（唯一入口，避免各处重复写「刷新 + 时效判断」）。
 *
 * 约定：**只报确认过的锁定**——无观测者、过期、查询失败一律 `locked=false`
 * 且 `value=null`，由调用方按自己的方向选择保守策略：
 * 对外开口的动作（主动发送）在 unknown 时停手；读一条**用户已单独授权**的
 * 通道（屏幕文字摘录）在 unknown 时不额外阻断，仍由 TTL 与授权开关兜住。
 */
export async function readBusyObservation(
  observer: BusyObserver | null,
  clock: Clock,
  maxAgeMs: number = BUSY_OBSERVATION_MAX_AGE_MS,
): Promise<BusyReading> {
  if (!observer) return { value: null, locked: false, reasonCode: "no_observer" };
  await observer.refresh();
  const observation = observer.current();
  const age = clock.now() - observation.observedMonotonicMs;
  if (observation.value === null || age > maxAgeMs) {
    return { value: null, locked: false, reasonCode: age > maxAgeMs ? "stale" : observation.reasonCode };
  }
  return {
    value: observation.value,
    locked: observation.reasonCode === BUSY_REASON_LOCKED,
    reasonCode: observation.reasonCode,
  };
}
