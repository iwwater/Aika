import { describe, expect, it } from "vitest";
import { EnvironmentSourceError, type EnvironmentMonitor } from "./contracts";
import {
  createFakeEnvironmentSource,
  createManualClock,
  fakeEventInput,
  type FakeEnvironmentSource,
} from "./fakeEnvironment";
import type { EnvironmentEvent } from "../../domain/environment";
import type { EnvironmentMonitorOptions } from "./monitor";

/**
 * monitor 语义共享用例包（FE-18）。
 *
 * 生产 monitor 与未来任何 `EnvironmentMonitor` 实现跑同一组用例；**只有 source
 * 用 fake**——用 fake monitor 冒充被测实现等于没有验收（FE-18 审阅补充）。
 *
 * 覆盖 AC：A schema 防御、B 汇聚语义、C 去重频控、D 快照、G 生命周期竞态、
 * H recent/TTL、I 敌意输入、J 状态轨迹。
 * E（policy 纯度）与 F（装配语义）分别在 policy 与插件测试里：前者不依赖 monitor，
 * 后者属于插件层。
 */

export const ENV_CONFORMANCE_EPOCH = "test-epoch";

export type EnvironmentMonitorFactory = (
  sources: readonly FakeEnvironmentSource[],
  options: EnvironmentMonitorOptions,
) => EnvironmentMonitor;

export function runEnvironmentMonitorConformance(
  name: string,
  buildMonitor: EnvironmentMonitorFactory,
): void {
  /** 组装：默认注入 conformance epoch 与手动时钟；overrides 可替换。 */
  const make = (
    sources: readonly FakeEnvironmentSource[],
    overrides: Partial<EnvironmentMonitorOptions> = {},
  ): { monitor: EnvironmentMonitor; clock: ReturnType<typeof createManualClock> } => {
    const clock = overrides.clock ?? createManualClock(0);
    const wallClock = overrides.wallClock ?? createManualClock(1_000_000);
    const monitor = buildMonitor(sources, {
      clock,
      hostEpoch: ENV_CONFORMANCE_EPOCH,
      wallClock,
      ...overrides,
    });
    return { monitor, clock: clock as ReturnType<typeof createManualClock> };
  };

  /** 启动一个 source 并等到 running。 */
  async function startRunning(source: FakeEnvironmentSource, monitor: EnvironmentMonitor): Promise<void> {
    const done = monitor.setSourceEnabled(source.id, true);
    source.resolveStart();
    await done;
  }

  describe(`${name} · FE-18-A schema 防御`, () => {
    it("缺 schemaVersion、版本不符、未知 payload kind 被丢弃并计数，不抛错不广播", async () => {
      const source = createFakeEnvironmentSource({ id: "fg" });
      const { monitor } = make([source]);
      await startRunning(source, monitor);
      const seen: EnvironmentEvent[] = [];
      monitor.subscribe((event) => seen.push(event));

      source.emit({ ...fakeEventInput({ payload: { kind: "foreground_changed", process: "A" }, sourceId: "fg" }), schemaVersion: undefined as never });
      source.emit({ ...fakeEventInput({ payload: { kind: "foreground_changed", process: "A" }, sourceId: "fg" }), schemaVersion: "environment.v2" as never });
      source.emit(fakeEventInput({ payload: { kind: "alien_kind" } as never, sourceId: "fg" }));

      expect(seen).toEqual([]);
      expect(monitor.diagnostics().schemaRejected).toBe(3);
    });

    it("confidence 非 0..1（NaN/Infinity/越界）与畸形数值被拒绝", async () => {
      const source = createFakeEnvironmentSource({ id: "fg" });
      const { monitor } = make([source]);
      await startRunning(source, monitor);
      const seen: EnvironmentEvent[] = [];
      monitor.subscribe((event) => seen.push(event));

      for (const confidence of [Number.NaN, Number.POSITIVE_INFINITY, 1.5, -0.1]) {
        source.emit(fakeEventInput({ payload: { kind: "game_event", event: "victory" }, sourceId: "fg", confidence }));
      }
      source.emit(fakeEventInput({ payload: { kind: "idle_changed", idleSeconds: Number.NaN }, sourceId: "fg" }));

      expect(seen).toEqual([]);
      expect(monitor.diagnostics().schemaRejected).toBe(5);
    });

    it("sourceId 缺失或与注册 source 不符、eventId/epoch 为空被拒绝", async () => {
      const source = createFakeEnvironmentSource({ id: "fg" });
      const { monitor } = make([source]);
      await startRunning(source, monitor);

      source.emit(fakeEventInput({ payload: { kind: "game_event", event: "victory" }, sourceId: "other" }));
      source.emit({ ...fakeEventInput({ payload: { kind: "game_event", event: "victory" }, sourceId: "fg" }), eventId: "" });
      source.emit({ ...fakeEventInput({ payload: { kind: "game_event", event: "victory" }, sourceId: "fg" }), hostEpoch: "" });

      expect(monitor.diagnostics().schemaRejected).toBe(3);
    });

    it("宿主 epoch 不匹配（旧会话残余）被单独计数", async () => {
      const source = createFakeEnvironmentSource({ id: "fg" });
      const { monitor } = make([source]);
      await startRunning(source, monitor);

      source.emit(fakeEventInput({ payload: { kind: "game_event", event: "victory" }, sourceId: "fg", hostEpoch: "old-epoch" }));

      expect(monitor.diagnostics().staleEpochRejected).toBe(1);
    });

    it("注入墙钟时未来时间被拒绝并单独计数；有效事件正常通过", async () => {
      const source = createFakeEnvironmentSource({ id: "fg" });
      const wallClock = createManualClock(1_000_000);
      const { monitor } = make([source], { wallClock });
      await startRunning(source, monitor);
      const seen: EnvironmentEvent[] = [];
      monitor.subscribe((event) => seen.push(event));

      source.emit(fakeEventInput({ payload: { kind: "game_event", event: "victory" }, sourceId: "fg", timestamp: 1_000_000 + 10 * 60_000 }));
      expect(seen).toEqual([]);
      expect(monitor.diagnostics().futureTimestampRejected).toBe(1);

      source.emit(fakeEventInput({ payload: { kind: "game_event", event: "victory" }, sourceId: "fg" }));
      expect(seen).toHaveLength(1);
    });
  });

  describe(`${name} · FE-18-B 汇聚语义`, () => {
    it("多 source 事件按序广播；退订生效", async () => {
      const clock = createManualClock(0);
      const a = createFakeEnvironmentSource({ id: "a" });
      const b = createFakeEnvironmentSource({ id: "b" });
      const { monitor } = make([a, b], { clock, dedupeWindowMs: 0 });
      await startRunning(a, monitor);
      await startRunning(b, monitor);

      const seen: string[] = [];
      const unsubscribe = monitor.subscribe((event) => seen.push(event.eventId));

      a.emit(fakeEventInput({ payload: { kind: "game_event", event: "victory" }, sourceId: "a", eventId: "a1" }));
      b.emit(fakeEventInput({ payload: { kind: "game_event", event: "defeat" }, sourceId: "b", eventId: "b1" }));
      a.emit(fakeEventInput({ payload: { kind: "game_event", event: "victory" }, sourceId: "a", eventId: "a2" }));
      expect(seen).toEqual(["a1", "b1", "a2"]);

      unsubscribe();
      a.emit(fakeEventInput({ payload: { kind: "game_event", event: "defeat" }, sourceId: "a", eventId: "a3" }));
      expect(seen).toEqual(["a1", "b1", "a2"]);
    });

    it("单个 listener 抛错被隔离并计数，其他 listener 与后续事件不受影响", async () => {
      const clock = createManualClock(0);
      const source = createFakeEnvironmentSource({ id: "fg" });
      const { monitor } = make([source], { clock, dedupeWindowMs: 0 });
      await startRunning(source, monitor);

      const good: string[] = [];
      monitor.subscribe(() => {
        throw new Error("broken listener");
      });
      monitor.subscribe((event) => good.push(event.eventId));

      source.emit(fakeEventInput({ payload: { kind: "game_event", event: "victory" }, sourceId: "fg", eventId: "e1" }));
      source.emit(fakeEventInput({ payload: { kind: "game_event", event: "victory" }, sourceId: "fg", eventId: "e2" }));

      expect(good).toEqual(["e1", "e2"]);
      expect(monitor.diagnostics().listenerErrors).toBe(2);
    });

    it("onStateChange 的 listener 抛错同样隔离", async () => {
      const source = createFakeEnvironmentSource({ id: "fg" });
      const { monitor } = make([source]);
      const seen: number[] = [];
      monitor.onStateChange(() => {
        seen.push(1);
        throw new Error("broken");
      });

      await startRunning(source, monitor);
      expect(seen.length).toBeGreaterThan(0);
      expect(monitor.statuses()[0].state).toBe("running");
    });
  });

  describe(`${name} · FE-18-C 去重与频控`, () => {
    it("同一 payload 在去重窗口内只广播一次；窗口过后再通过", async () => {
      const clock = createManualClock(0);
      const source = createFakeEnvironmentSource({ id: "fg" });
      const { monitor } = make([source], { clock, dedupeWindowMs: 2000 });
      await startRunning(source, monitor);
      const seen: EnvironmentEvent[] = [];
      monitor.subscribe((event) => seen.push(event));

      const victory = () => fakeEventInput({ payload: { kind: "game_event", event: "victory" }, sourceId: "fg", eventId: `e${seen.length}` });
      source.emit(victory());
      source.emit(victory());
      expect(seen).toHaveLength(1);
      expect(monitor.diagnostics().dedupeDropped).toBe(1);

      clock.advance(2000);
      source.emit(victory());
      expect(seen).toHaveLength(2);
    });

    it("不同 payload 不互相去重；去重按 source 隔离", async () => {
      const clock = createManualClock(0);
      const a = createFakeEnvironmentSource({ id: "a" });
      const b = createFakeEnvironmentSource({ id: "b" });
      const { monitor } = make([a, b], { clock, dedupeWindowMs: 2000 });
      await startRunning(a, monitor);
      await startRunning(b, monitor);
      const seen: EnvironmentEvent[] = [];
      monitor.subscribe((event) => seen.push(event));

      a.emit(fakeEventInput({ payload: { kind: "game_event", event: "victory" }, sourceId: "a" }));
      a.emit(fakeEventInput({ payload: { kind: "game_event", event: "defeat" }, sourceId: "a" }));
      b.emit(fakeEventInput({ payload: { kind: "game_event", event: "victory" }, sourceId: "b" }));
      expect(seen).toHaveLength(3);
    });

    it("每分钟超过 maxPerMinute 静默丢弃，丢弃计数可见；窗口滑动后恢复", async () => {
      const clock = createManualClock(0);
      const source = createFakeEnvironmentSource({ id: "fg" });
      const { monitor } = make([source], { clock, maxPerMinute: 3, dedupeWindowMs: 0 });
      await startRunning(source, monitor);
      const seen: EnvironmentEvent[] = [];
      monitor.subscribe((event) => seen.push(event));

      for (let index = 0; index < 5; index += 1) {
        source.emit(fakeEventInput({ payload: { kind: "game_event", event: `evt-${index}` }, sourceId: "fg" }));
        clock.advance(10);
      }
      expect(seen).toHaveLength(3);
      expect(monitor.diagnostics().rateLimitedDropped).toBe(2);

      clock.advance(60_000);
      source.emit(fakeEventInput({ payload: { kind: "game_event", event: "evt-late" }, sourceId: "fg" }));
      expect(seen).toHaveLength(4);
    });
  });

  describe(`${name} · FE-18-D 快照`, () => {
    it("foreground_changed 更新 snapshot；其他 kind 不改变 foreground", async () => {
      const source = createFakeEnvironmentSource({ id: "fg" });
      const { monitor } = make([source]);
      await startRunning(source, monitor);

      source.emit(fakeEventInput({ payload: { kind: "foreground_changed", process: "Code.exe" }, sourceId: "fg" }));
      expect(monitor.snapshot.foreground).toEqual({ process: "Code.exe", since: 0 });

      source.emit(fakeEventInput({ payload: { kind: "game_event", event: "victory" }, sourceId: "fg" }));
      source.emit(fakeEventInput({ payload: { kind: "idle_changed", idleSeconds: 30 }, sourceId: "fg" }));
      expect(monitor.snapshot.foreground).toEqual({ process: "Code.exe", since: 0 });
    });

    it("A→B→A 快速切换后快照停留在最新 A（since 更新），去重不影响状态正确性", async () => {
      const clock = createManualClock(0);
      const source = createFakeEnvironmentSource({ id: "fg" });
      const { monitor } = make([source], { clock });
      await startRunning(source, monitor);

      source.emit(fakeEventInput({ payload: { kind: "foreground_changed", process: "A" }, sourceId: "fg" }));
      clock.advance(10);
      source.emit(fakeEventInput({ payload: { kind: "foreground_changed", process: "B" }, sourceId: "fg" }));
      clock.advance(10);
      // 第三个 A 在去重窗口内被省略广播，但快照仍要落到 A。
      source.emit(fakeEventInput({ payload: { kind: "foreground_changed", process: "A" }, sourceId: "fg" }));

      expect(monitor.snapshot.foreground).toEqual({ process: "A", since: 20 });
      expect(monitor.diagnostics().dedupeDropped).toBe(1);
    });

    it("标题在规范化入口剥离：快照与广播事件都不含 title", async () => {
      const source = createFakeEnvironmentSource({ id: "fg" });
      const { monitor } = make([source]);
      await startRunning(source, monitor);
      const seen: EnvironmentEvent[] = [];
      monitor.subscribe((event) => seen.push(event));

      source.emit(fakeEventInput({
        payload: { kind: "foreground_changed", process: "Code.exe", title: "secret.txt - Editor" },
        sourceId: "fg",
      }));

      expect(monitor.snapshot.foreground).toEqual({ process: "Code.exe", since: 0 });
      expect(seen).toHaveLength(1);
      expect(JSON.stringify(seen[0])).not.toContain("secret.txt");
      expect(seen[0].payload).not.toHaveProperty("title");
    });

    it("source 关闭后前台快照失效", async () => {
      const source = createFakeEnvironmentSource({ id: "fg" });
      const { monitor } = make([source]);
      await startRunning(source, monitor);
      source.emit(fakeEventInput({ payload: { kind: "foreground_changed", process: "Code.exe" }, sourceId: "fg" }));
      expect(monitor.snapshot.foreground).not.toBeNull();

      await monitor.setSourceEnabled("fg", false);
      expect(monitor.snapshot.foreground).toBeNull();
    });
  });

  describe(`${name} · FE-18-G 生命周期`, () => {
    it("ready 前 abort：迟到返回的 stop 也执行，终态 off，零广播", async () => {
      const source = createFakeEnvironmentSource({ id: "fg", autoSettleOnAbort: false });
      const { monitor } = make([source]);
      const enablePromise = monitor.setSourceEnabled("fg", true);
      // start 挂起期间发出停止请求：abort 已发生。
      const disablePromise = monitor.setSourceEnabled("fg", false);
      source.resolveStart();
      await Promise.all([enablePromise, disablePromise]);

      expect(source.stopCount).toBe(1);
      expect(monitor.statuses()[0]).toMatchObject({ state: "off", generation: 1 });

      const seen: EnvironmentEvent[] = [];
      monitor.subscribe((event) => seen.push(event));
      source.emit(fakeEventInput({ payload: { kind: "game_event", event: "victory" }, sourceId: "fg" }));
      expect(seen).toEqual([]);
      expect(monitor.diagnostics().staleGenerationDropped).toBeGreaterThan(0);
    });

    it("start 失败：denied 与普通错误分别落 denied/error，可重试", async () => {
      const source = createFakeEnvironmentSource({ id: "fg", autoSettleOnAbort: false });
      const { monitor } = make([source]);

      const first = monitor.setSourceEnabled("fg", true);
      source.rejectStart(new EnvironmentSourceError("denied"));
      await first;
      expect(monitor.statuses()[0]).toMatchObject({ state: "denied", error: "denied" });

      const second = monitor.setSourceEnabled("fg", true);
      source.rejectStart(new Error("boom"));
      await second;
      expect(monitor.statuses()[0]).toMatchObject({ state: "error", error: "start_failed" });
      expect(monitor.diagnostics().sourceStartFailed).toBe(2);

      const third = monitor.setSourceEnabled("fg", true);
      source.resolveStart();
      await third;
      expect(monitor.statuses()[0]).toMatchObject({ state: "running", error: null });
    });

    it("重复开关无泄漏：start/stop 次数一致，终态 off", async () => {
      const source = createFakeEnvironmentSource({ id: "fg" });
      const { monitor } = make([source]);
      for (let index = 0; index < 3; index += 1) {
        await startRunning(source, monitor);
        expect(monitor.statuses()[0].state).toBe("running");
        await monitor.setSourceEnabled("fg", false);
        expect(monitor.statuses()[0].state).toBe("off");
      }
      expect(source.startCount).toBe(3);
      expect(source.stopCount).toBe(3);
    });

    it("已 running 时重复 enable 幂等；off 时重复 disable 幂等", async () => {
      const source = createFakeEnvironmentSource({ id: "fg" });
      const { monitor } = make([source]);
      await startRunning(source, monitor);
      await monitor.setSourceEnabled("fg", true);
      expect(source.startCount).toBe(1);

      await monitor.setSourceEnabled("fg", false);
      await monitor.setSourceEnabled("fg", false);
      expect(source.stopCount).toBe(1);
      expect(monitor.statuses()[0].state).toBe("off");
    });

    it("stop 抛错：状态为 error（不伪称 off），清缓存，可重试且能再次运行", async () => {
      const source = createFakeEnvironmentSource({ id: "fg" });
      const { monitor } = make([source]);
      await startRunning(source, monitor);
      source.emit(fakeEventInput({ payload: { kind: "foreground_changed", process: "A" }, sourceId: "fg" }));
      source.setStopBehavior("fail");

      await monitor.setSourceEnabled("fg", false);
      expect(monitor.statuses()[0]).toMatchObject({ state: "error", error: "stop_failed" });
      expect(monitor.diagnostics().sourceStopFailed).toBe(1);
      expect(monitor.snapshot.foreground).toBeNull();
      expect(monitor.recent()).toEqual([]);

      source.setStopBehavior("ok");
      await startRunning(source, monitor);
      expect(monitor.statuses()[0]).toMatchObject({ state: "running", error: null });
    });

    it("单 source 失败不影响其他 source：一源 stop 失败，stopAll 仍停止其余", async () => {
      const bad = createFakeEnvironmentSource({ id: "bad" });
      const good = createFakeEnvironmentSource({ id: "good" });
      const { monitor } = make([bad, good]);
      await startRunning(bad, monitor);
      await startRunning(good, monitor);
      bad.setStopBehavior("fail");

      await monitor.stopAll();
      expect(monitor.statuses().find((status) => status.sourceId === "good")?.state).toBe("off");
      expect(monitor.statuses().find((status) => status.sourceId === "bad")?.state).toBe("error");
    });

    it("旧 generation 的迟到 emit 零广播（重启用新 generation 后旧回调被拒）", async () => {
      const clock = createManualClock(0);
      const source = createFakeEnvironmentSource({ id: "fg", autoSettleOnAbort: false });
      const { monitor } = make([source], { clock, dedupeWindowMs: 0 });
      const seen: EnvironmentEvent[] = [];
      monitor.subscribe((event) => seen.push(event));

      await startRunning(source, monitor);
      source.emit(fakeEventInput({ payload: { kind: "game_event", event: "first" }, sourceId: "fg" }));
      expect(seen).toHaveLength(1);

      await monitor.setSourceEnabled("fg", false);
      await startRunning(source, monitor);

      // 用第一次 start 注册的旧回调发事件：generation 已失效。
      source.emitViaStart(0, fakeEventInput({ payload: { kind: "game_event", event: "stale" }, sourceId: "fg" }));
      expect(seen).toHaveLength(1);
      expect(monitor.diagnostics().staleGenerationDropped).toBeGreaterThanOrEqual(1);

      source.emit(fakeEventInput({ payload: { kind: "game_event", event: "fresh" }, sourceId: "fg" }));
      expect(seen).toHaveLength(2);
    });

    it("stopAll：先撤销再等待，全部 off，快照与 recent 清空；dispose 幂等且拒绝再启用", async () => {
      const a = createFakeEnvironmentSource({ id: "a" });
      const b = createFakeEnvironmentSource({ id: "b" });
      const { monitor } = make([a, b]);
      await startRunning(a, monitor);
      await startRunning(b, monitor);
      a.emit(fakeEventInput({ payload: { kind: "foreground_changed", process: "A" }, sourceId: "a" }));
      b.emit(fakeEventInput({ payload: { kind: "game_event", event: "victory" }, sourceId: "b" }));
      expect(monitor.snapshot.foreground).not.toBeNull();
      expect(monitor.recent()).toHaveLength(2);

      await monitor.stopAll();
      expect(monitor.statuses().every((status) => status.state === "off")).toBe(true);
      expect(monitor.snapshot.foreground).toBeNull();
      expect(monitor.recent()).toEqual([]);

      await monitor.dispose();
      await monitor.dispose();
      await expect(monitor.setSourceEnabled("a", true)).rejects.toMatchObject({ code: "disposed" });
      const seen: EnvironmentEvent[] = [];
      monitor.subscribe((event) => seen.push(event));
      a.emit(fakeEventInput({ payload: { kind: "game_event", event: "victory" }, sourceId: "a" }));
      expect(seen).toEqual([]);
    });

    it("未知 sourceId 抛 unknown_source", async () => {
      const { monitor } = make([]);
      await expect(monitor.setSourceEnabled("ghost", true)).rejects.toMatchObject({ code: "unknown_source" });
    });
  });

  describe(`${name} · FE-18-H recent 与 TTL`, () => {
    it("第 21 条挤出最旧条", async () => {
      const clock = createManualClock(0);
      const source = createFakeEnvironmentSource({ id: "fg" });
      const { monitor } = make([source], { clock, dedupeWindowMs: 0 });
      await startRunning(source, monitor);

      for (let index = 0; index < 21; index += 1) {
        clock.advance(1);
        source.emit(fakeEventInput({ payload: { kind: "game_event", event: `evt-${index}` }, sourceId: "fg" }));
      }
      const recent = monitor.recent();
      expect(recent).toHaveLength(20);
      expect(recent[0].ruleId).toBe("evt-1");
      expect(recent[19].ruleId).toBe("evt-20");
    });

    it("60000ms 边界过期；墙钟字段回拨不延长 TTL", async () => {
      const clock = createManualClock(0);
      const source = createFakeEnvironmentSource({ id: "fg" });
      const { monitor } = make([source], { clock });
      await startRunning(source, monitor);

      // timestamp 是极旧的墙钟值：TTL 不得由它延长。
      source.emit(fakeEventInput({ payload: { kind: "game_event", event: "victory" }, sourceId: "fg", timestamp: 0 }));
      expect(monitor.recent()).toHaveLength(1);

      clock.advance(59_999);
      expect(monitor.recent()).toHaveLength(1);
      clock.advance(1);
      expect(monitor.recent()).toHaveLength(0);
    });

    it("关闭单 source 只清它的 recent；stopAll 清空全部", async () => {
      const clock = createManualClock(0);
      const a = createFakeEnvironmentSource({ id: "a" });
      const b = createFakeEnvironmentSource({ id: "b" });
      const { monitor } = make([a, b], { clock, dedupeWindowMs: 0 });
      await startRunning(a, monitor);
      await startRunning(b, monitor);

      a.emit(fakeEventInput({ payload: { kind: "game_event", event: "from-a" }, sourceId: "a" }));
      b.emit(fakeEventInput({ payload: { kind: "game_event", event: "from-b" }, sourceId: "b" }));
      expect(monitor.recent()).toHaveLength(2);

      await monitor.setSourceEnabled("a", false);
      expect(monitor.recent().map((entry) => entry.sourceId)).toEqual(["b"]);

      b.emit(fakeEventInput({ payload: { kind: "game_event", event: "from-b-2" }, sourceId: "b" }));
      await monitor.stopAll();
      expect(monitor.recent()).toEqual([]);
    });
  });

  describe(`${name} · FE-18-I 敌意输入`, () => {
    it("标题、长文本、NaN、旧 epoch、异常 listener 同时注入：防御生效且互相不干扰", async () => {
      const source = createFakeEnvironmentSource({ id: "fg" });
      const { monitor } = make([source]);
      const leaked: string[] = [];
      monitor.subscribe(() => {
        throw new Error("hostile listener");
      });
      monitor.subscribe((event) => leaked.push(JSON.stringify(event)));
      await startRunning(source, monitor);

      source.emit(fakeEventInput({
        payload: { kind: "foreground_changed", process: "Code.exe", title: "SECRET-TITLE" },
        sourceId: "fg",
      }));
      source.emit(fakeEventInput({
        payload: { kind: "screen_keyword", keyword: "Error", text: "SECRET-OCR-TEXT".repeat(500) },
        sourceId: "fg",
      }));
      source.emit(fakeEventInput({ payload: { kind: "game_event", event: "victory" }, sourceId: "fg", confidence: Number.NaN }));
      source.emit(fakeEventInput({ payload: { kind: "game_event", event: "defeat" }, sourceId: "fg", hostEpoch: "old" }));

      const joined = leaked.join("\n");
      expect(joined).not.toContain("SECRET-TITLE");
      expect(joined).not.toContain("SECRET-OCR-TEXT");
      expect(monitor.diagnostics().schemaRejected).toBe(1);
      expect(monitor.diagnostics().staleEpochRejected).toBe(1);
      expect(monitor.diagnostics().listenerErrors).toBe(2);
      // 异常 listener 不影响后续事件进入 recent（foreground 条目 ruleId 为 null）。
      expect(monitor.recent().map((entry) => entry.ruleId)).toEqual([null, "Error"]);
    });
  });

  describe(`${name} · FE-18-J 状态轨迹`, () => {
    it("starting→running→stopping→off 轨迹正确", async () => {
      const source = createFakeEnvironmentSource({ id: "fg", autoSettleOnAbort: false });
      const { monitor } = make([source]);
      const trajectory: string[] = [];
      monitor.onStateChange(() => {
        trajectory.push(monitor.statuses()[0].state);
      });

      const enable = monitor.setSourceEnabled("fg", true);
      expect(monitor.statuses()[0].state).toBe("starting");
      source.resolveStart();
      await enable;
      expect(monitor.statuses()[0].state).toBe("running");

      await monitor.setSourceEnabled("fg", false);
      expect(trajectory).toEqual(["starting", "running", "stopping", "off"]);
    });

    it("denied 状态可见且错误只含代码，不泄漏正文", async () => {
      const source = createFakeEnvironmentSource({ id: "fg", autoSettleOnAbort: false });
      const { monitor } = make([source]);
      const enable = monitor.setSourceEnabled("fg", true);
      source.rejectStart(new EnvironmentSourceError("denied", "screen permission denied"));
      await enable;
      const status = monitor.statuses()[0];
      expect(status.state).toBe("denied");
      expect(status.error).toBe("denied");
      expect(JSON.stringify(status)).not.toContain("permission");
    });
  });
}
