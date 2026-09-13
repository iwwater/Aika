import { describe, expect, it } from "vitest";
import { createKernel } from "../../kernel";
import { createManualClock, createFakeEnvironmentSource, fakeEventInput } from "../../services/environment/fakeEnvironment";
import {
  EnvironmentMonitorToken,
  EnvironmentSourcesToken,
  ProactivePolicyToken,
} from "../../services/environment/contracts";
import { environmentPlugin } from "./environmentPlugin";

/**
 * FE-18-F 装配语义。
 *
 * 宿主无 sources 时 `environment.monitor` token 不注册（tryResolve 得 null），
 * `environment.proactivePolicy` 恒注册；有 sources 时两者都在，且 monitor 可用。
 */

describe("environmentPlugin（FE-18-F）", () => {
  it("无 sources：policy 恒注册，monitor 不注册", async () => {
    const kernel = createKernel();
    kernel.use(environmentPlugin());
    const report = await kernel.start();
    expect(report.ok).toBe(true);

    expect(kernel.registry.tryResolve(EnvironmentMonitorToken)).toBeNull();
    const policy = kernel.registry.tryResolve(ProactivePolicyToken);
    expect(policy).not.toBeNull();
    // 默认策略对五种 kind 返回 ignore（在真实内核装配下抽查一种）。
    expect(policy?.evaluate({
      event: {
        schemaVersion: "environment.v1",
        sourceId: "s",
        eventId: "e",
        hostEpoch: "epoch",
        timestamp: 0,
        receivedMonotonicMs: 0,
        timingPrecision: "measured",
        confidence: 1,
        payload: { kind: "game_event", event: "victory" },
      },
      now: 0,
      lastSentAt: null,
      proactiveToday: null,
      userBusy: null,
      sustainedMs: 0,
      occurrencesInWindow: 0,
    }).action).toBe("ignore");
  });

  it("有 sources：monitor 与 policy 都注册，monitor 可启停 source 并广播", async () => {
    const source = createFakeEnvironmentSource({ id: "fg" });
    const clock = createManualClock(0);
    const kernel = createKernel();
    kernel.use(environmentPlugin({ sources: [source], clock, hostEpoch: "test-epoch" }));
    const report = await kernel.start();
    expect(report.ok).toBe(true);

    const monitor = kernel.registry.resolve(EnvironmentMonitorToken);
    expect(monitor).not.toBeNull();
    expect(kernel.registry.tryResolve(ProactivePolicyToken)).not.toBeNull();

    const seen: string[] = [];
    monitor.subscribe((event) => seen.push(event.eventId));
    const done = monitor.setSourceEnabled("fg", true);
    source.resolveStart();
    await done;
    source.emit(fakeEventInput({ payload: { kind: "game_event", event: "victory" }, sourceId: "fg", eventId: "e1" }));
    expect(seen).toEqual(["e1"]);

    await kernel.dispose();
  });

  it("EnvironmentSourcesToken 可由宿主独立发布（FE-19 的发布形态）", async () => {
    const source = createFakeEnvironmentSource({ id: "fg" });
    const clock = createManualClock(0);
    const sourcesPlugin = {
      id: "host.environmentSources",
      version: "1.0.0",
      provides: [EnvironmentSourcesToken],
      activate(context: { registrar: { provide: (token: typeof EnvironmentSourcesToken, factory: () => readonly unknown[]) => void } }) {
        context.registrar.provide(EnvironmentSourcesToken, () => [source]);
      },
    };
    const kernel = createKernel();
    kernel.use(sourcesPlugin);
    kernel.use(environmentPlugin({ sources: [source], clock, hostEpoch: "test-epoch" }));
    const report = await kernel.start();
    expect(report.ok).toBe(true);
    expect(kernel.registry.resolve(EnvironmentSourcesToken)).toEqual([source]);
    await kernel.dispose();
  });
});
