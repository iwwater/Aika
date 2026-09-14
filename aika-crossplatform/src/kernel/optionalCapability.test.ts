import { afterEach, describe, expect, it, vi } from "vitest";
import { createOptionalCapability } from "./optionalCapability";

afterEach(() => vi.useRealTimers());
describe("optional capability lifecycle", () => {
  it("deduplicates starts and supports twenty independent restart cycles", async () => {
    const cleanup = vi.fn();
    const start = vi.fn(async () => cleanup);
    const unit = createOptionalCapability({ start });
    for (let i = 0; i < 20; i++) {
      await Promise.all([unit.start(), unit.start()]);
      expect((await unit.health()).state).toBe("running");
      await Promise.all([unit.stop(), unit.stop()]);
      expect(unit.snapshot().state).toBe("off");
    }
    expect(start).toHaveBeenCalledTimes(20);
    expect(cleanup).toHaveBeenCalledTimes(20);
  });
  it("isolates startup, health and listener errors", async () => {
    const broken = createOptionalCapability({ start: async () => { throw Error("private"); } });
    const good = createOptionalCapability({ start: async () => () => undefined });
    good.subscribe(() => { throw Error("listener"); });
    await Promise.all([broken.start(), good.start()]);
    expect(broken.snapshot()).toMatchObject({ state: "failed", code: "start_failed" });
    expect((await good.health()).state).toBe("running");
    await good.stop();
    const unhealthy = createOptionalCapability({ start: async () => () => undefined, check: async () => { throw Error(); } });
    await unhealthy.start();
    expect(await unhealthy.health()).toMatchObject({ state: "failed", code: "health_failed" });
    await unhealthy.stop();
  });
  it("revokes a starting generation and cleans up late resources exactly once", async () => {
    let finish!: (cleanup: () => void) => void;
    let signal!: AbortSignal;
    const cleanup = vi.fn();
    const unit = createOptionalCapability({ start: (input) => { signal = input; return new Promise((r) => { finish = r; }); } });
    const starting = unit.start();
    const stopping = unit.stop();
    expect(signal.aborted).toBe(true);
    finish(cleanup);
    await Promise.all([starting, stopping]);
    expect(unit.snapshot().state).toBe("off");
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
  it("bounds hung startup and quarantines it instead of overlapping new instances", async () => {
    vi.useFakeTimers();
    let finish!: (cleanup: () => void) => void;
    const start = vi.fn(() => new Promise<() => void>((r) => { finish = r; }));
    const unit = createOptionalCapability({ start, timeoutMs: 20 });
    const result = unit.start();
    await vi.advanceTimersByTimeAsync(20);
    expect(await result).toMatchObject({ state: "failed", code: "timeout" });
    await unit.start();
    expect(start).toHaveBeenCalledTimes(1);
    const cleanup = vi.fn();
    finish(cleanup);
    await vi.runAllTimersAsync();
    expect(cleanup).toHaveBeenCalledTimes(1);
    await unit.stop();
    expect(unit.snapshot().state).toBe("off");
  });
  it("bounds cleanup and isolates its error", async () => {
    vi.useFakeTimers();
    const unit = createOptionalCapability({ start: async () => () => new Promise<void>(() => undefined), timeoutMs: 20 });
    await unit.start();
    const result = unit.stop();
    await vi.advanceTimersByTimeAsync(20);
    expect(await result).toMatchObject({ state: "failed", code: "timeout" });
    expect((await unit.start()).state).toBe("failed");
    expect(vi.getTimerCount()).toBe(0);
    const broken = createOptionalCapability({ start: async () => () => { throw Error(); } });
    await broken.start();
    expect(await broken.stop()).toMatchObject({ state: "failed", code: "stop_failed" });
  });
});
