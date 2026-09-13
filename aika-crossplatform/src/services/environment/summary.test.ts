import { describe, expect, it } from "vitest";
import { createManualClock, createFakeEnvironmentSource, fakeEventInput } from "./fakeEnvironment";
import { createEnvironmentMonitor } from "./monitor";
import { buildEnvironmentSummary } from "./summary";

/**
 * 模型出口摘要 DTO 测试（FE-18 2026-09-14 修订）。
 *
 * 出口只含受控字段：process 名、持续时间、kind / 词表 ID、置信度、年龄。
 * 标题与 OCR 原文即使被 source 夹带，也到不了这里。
 */

/** fake source 的 start 要手动放行：先发起 enable，再 resolve，最后 await。 */
async function startRunning(source: ReturnType<typeof createFakeEnvironmentSource>, monitor: ReturnType<typeof createEnvironmentMonitor>): Promise<void> {
  const done = monitor.setSourceEnabled(source.id, true);
  source.resolveStart();
  await done;
}

describe("buildEnvironmentSummary", () => {
  it("前台摘要：进程名 + 持续时长（按 monitor 时钟现算）", async () => {
    const clock = createManualClock(1000);
    const source = createFakeEnvironmentSource({ id: "fg" });
    const monitor = createEnvironmentMonitor([source], { clock, hostEpoch: "test-epoch" });
    await startRunning(source, monitor);
    source.emit(fakeEventInput({ payload: { kind: "foreground_changed", process: "Code.exe" }, sourceId: "fg" }));

    clock.advance(45_000);
    const summary = buildEnvironmentSummary(monitor, { clock });
    expect(summary.foreground).toEqual({ process: "Code.exe", durationMs: 45_000 });
  });

  it("recent 摘要：kind / 词表 ID / 置信度 / 年龄；无原文出口", async () => {
    const clock = createManualClock(0);
    const fg = createFakeEnvironmentSource({ id: "fg" });
    const screen = createFakeEnvironmentSource({ id: "screen" });
    const monitor = createEnvironmentMonitor([fg, screen], { clock, hostEpoch: "test-epoch", dedupeWindowMs: 0 });
    await startRunning(fg, monitor);
    await startRunning(screen, monitor);
    clock.advance(10);
    fg.emit(fakeEventInput({
      payload: { kind: "foreground_changed", process: "Code.exe", title: "SECRET-TITLE" },
      sourceId: "fg",
      confidence: 1,
    }));
    clock.advance(5);
    screen.emit(fakeEventInput({
      payload: { kind: "screen_keyword", keyword: "Error", text: "SECRET-OCR" },
      sourceId: "screen",
      confidence: 0.9,
    }));
    clock.advance(15);

    const summary = buildEnvironmentSummary(monitor, { clock });
    expect(summary.recent).toEqual([
      { kind: "foreground_changed", ruleId: null, process: "Code.exe", confidence: 1, ageMs: 20 },
      { kind: "screen_keyword", ruleId: "Error", process: null, confidence: 0.9, ageMs: 15 },
    ]);
    expect(JSON.stringify(summary)).not.toContain("SECRET");
  });

  it("source 停止后前台摘要立即失效；过期 recent 不进入摘要", async () => {
    const clock = createManualClock(0);
    const fg = createFakeEnvironmentSource({ id: "fg" });
    const monitor = createEnvironmentMonitor([fg], { clock, hostEpoch: "test-epoch" });
    await startRunning(fg, monitor);
    fg.emit(fakeEventInput({ payload: { kind: "foreground_changed", process: "Code.exe" }, sourceId: "fg" }));

    await monitor.setSourceEnabled("fg", false);
    clock.advance(70_000);
    const summary = buildEnvironmentSummary(monitor, { clock });
    expect(summary.foreground).toBeNull();
    expect(summary.recent).toEqual([]);
  });
});
