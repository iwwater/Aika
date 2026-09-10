import type { Clock, Timers } from "./tokens";

/** 真实时钟。测试注入假时钟，不改被测代码。 */
export function createSystemClock(): Clock {
  return { now: () => Date.now() };
}

export function createSystemTimers(): Timers {
  return {
    setTimeout: (handler, ms) => setTimeout(handler, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}
