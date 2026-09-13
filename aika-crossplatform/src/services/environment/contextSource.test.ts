import { describe, expect, it } from "vitest";
import { createManualClock, createFakeEnvironmentSource, fakeEventInput } from "./fakeEnvironment";
import { createEnvironmentMonitor } from "./monitor";
import { createEnvironmentContextSource } from "./contextSource";

/**
 * FE-19-D/E/H：环境上下文源。
 * - 授权开 → 只出规范化摘要（应用名 + 时长）；授权关 → 零模型摘要。
 * - load 后关闭 / TTL 过期 / source 停止 → 后续 load 无旧摘要。
 * - snippet 不含窗口标题原文。
 */

async function startRunning(source: ReturnType<typeof createFakeEnvironmentSource>, monitor: ReturnType<typeof createEnvironmentMonitor>): Promise<void> {
  const done = monitor.setSourceEnabled(source.id, true);
  source.resolveStart();
  await done;
}

function setup() {
  const clock = createManualClock(0);
  const fg = createFakeEnvironmentSource({ id: "foreground" });
  const monitor = createEnvironmentMonitor([fg], { clock, hostEpoch: "test-epoch" });
  let contextEnabled = false;
  const source = createEnvironmentContextSource({
    monitor,
    clock,
    getContextEnabled: async () => contextEnabled,
  });
  return {
    clock, fg, monitor, source,
    setAuthorized(value: boolean) { contextEnabled = value; },
  };
}

describe("environmentContextSource（FE-19-D/E/H）", () => {
  it("采集开、摘要关 → 零模型摘要；摘要开 → 只出受控摘要", async () => {
    const env = setup();
    await startRunning(env.fg, env.monitor);
    env.fg.emit(fakeEventInput({
      payload: { kind: "foreground_changed", process: "Code.exe", title: "SECRET-TITLE" },
      sourceId: "foreground",
    }));
    env.clock.advance(30_000);

    env.setAuthorized(false);
    expect(await env.source.load({})).toEqual([]);

    env.setAuthorized(true);
    const snippets = await env.source.load({});
    expect(snippets).toHaveLength(1);
    const text = JSON.stringify(snippets);
    expect(text).toContain("Code.exe");
    expect(text).toContain("30 秒");
    expect(text).not.toContain("SECRET-TITLE");
    expect(text).not.toContain("title");
  });

  it("TTL 过期与 source 停止后，load 不再返回旧摘要", async () => {
    const env = setup();
    await startRunning(env.fg, env.monitor);
    env.fg.emit(fakeEventInput({ payload: { kind: "foreground_changed", process: "Code.exe" }, sourceId: "foreground" }));
    env.setAuthorized(true);
    expect(await env.source.load({})).toHaveLength(1);

    // 前台摘要不因用户停留超过 60 秒失效——只由 source 运行状态决定。
    env.clock.advance(120_000);
    expect(await env.source.load({})).toHaveLength(1);

    // 关闭采集：monitor 清空快照，load 立即为空。
    await env.monitor.setSourceEnabled("foreground", false);
    expect(await env.source.load({})).toEqual([]);
  });

  it("screen_keyword 事件以词表 ID 计数进入摘要，OCR 原文不出现", async () => {
    const env = setup();
    const screen = createFakeEnvironmentSource({ id: "screen" });
    const monitor = createEnvironmentMonitor([env.fg, screen], { clock: env.clock, hostEpoch: "test-epoch", dedupeWindowMs: 0 });
    const source = createEnvironmentContextSource({
      monitor,
      clock: env.clock,
      getContextEnabled: async () => true,
    });
    await startRunning(env.fg, monitor);
    await startRunning(screen, monitor);
    env.fg.emit(fakeEventInput({ payload: { kind: "foreground_changed", process: "game.exe" }, sourceId: "foreground" }));
    screen.emit(fakeEventInput({
      payload: { kind: "screen_keyword", keyword: "VICTORY", text: "LONG OCR RAW TEXT" },
      sourceId: "screen",
      confidence: 0.9,
    }));

    const snippets = await source.load({});
    expect(snippets).toHaveLength(1);
    const text = JSON.stringify(snippets);
    expect(text).toContain("VICTORY");
    expect(text).not.toContain("LONG OCR RAW TEXT");
  });

  it("授权读取抛错按未授权处理（fail-closed）", async () => {
    const clock = createManualClock(0);
    const fg = createFakeEnvironmentSource({ id: "foreground" });
    const monitor = createEnvironmentMonitor([fg], { clock, hostEpoch: "test-epoch" });
    const done = monitor.setSourceEnabled("foreground", true);
    fg.resolveStart();
    await done;
    fg.emit(fakeEventInput({ payload: { kind: "foreground_changed", process: "Code.exe" }, sourceId: "foreground" }));
    const source = createEnvironmentContextSource({
      monitor,
      clock,
      getContextEnabled: async () => {
        throw new Error("storage broken");
      },
    });
    expect(await source.load({})).toEqual([]);
  });
});
