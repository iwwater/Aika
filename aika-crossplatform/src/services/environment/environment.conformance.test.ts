import { describe, expect, it } from "vitest";
import { runEnvironmentMonitorConformance } from "./environment.conformance";
import { createEnvironmentMonitor, type EnvironmentMonitorOptions } from "./monitor";
import type { FakeEnvironmentSource } from "./fakeEnvironment";
import type { EnvironmentMonitor } from "./contracts";

/**
 * 生产 monitor 跑共享用例包（FE-18-E）。
 *
 * 只有 source 用 fake；被验收的 monitor 是 `createEnvironmentMonitor` 生产实现。
 */

const productionFactory = (
  sources: readonly FakeEnvironmentSource[],
  options: EnvironmentMonitorOptions,
): EnvironmentMonitor => createEnvironmentMonitor(sources, options);

runEnvironmentMonitorConformance("生产 EnvironmentMonitor", productionFactory);

describe("生产 monitor 导出形状", () => {
  it("工厂接受空 source 集合并暴露全部契约方法", () => {
    const monitor = productionFactory([], { clock: { now: () => 0 }, hostEpoch: "e" });
    expect(monitor.snapshot).toEqual({ foreground: null });
    expect(monitor.statuses()).toEqual([]);
    expect(monitor.recent()).toEqual([]);
    expect(typeof monitor.subscribe).toBe("function");
    expect(typeof monitor.onStateChange).toBe("function");
    expect(typeof monitor.setSourceEnabled).toBe("function");
    expect(typeof monitor.stopAll).toBe("function");
    expect(typeof monitor.diagnostics).toBe("function");
    expect(typeof monitor.dispose).toBe("function");
  });
});
