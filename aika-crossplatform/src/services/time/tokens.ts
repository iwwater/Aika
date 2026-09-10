import { token } from "../../kernel";

/**
 * 时间端口。
 *
 * 这两个接口和 `RuntimeClock`（companionRuntime.ts）、`TimerPort`
 * （contextAssembler.ts）**结构相同**，是有意的：那两处不改，本模块的实现
 * 直接结构兼容地传进去即可。这里存在的理由只是「时钟和计时器是宿主提供的
 * 能力，不该挂在 LLM 模块的 token 上」。
 */

export interface Clock {
  now(): number;
}

export interface Timers {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const ClockToken = token<Clock>("time.clock");
export const TimersToken = token<Timers>("time.timers");
