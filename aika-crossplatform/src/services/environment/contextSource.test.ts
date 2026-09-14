import { describe, expect, it } from "vitest";
import { createManualClock, createFakeEnvironmentSource, fakeEventInput } from "./fakeEnvironment";
import { createEnvironmentMonitor } from "./monitor";
import { createEnvironmentContextSource, createScreenTextContextSource } from "./contextSource";
import { SCREEN_CONTEXT_SCHEMA_VERSION, SCREEN_CONTEXT_SOURCE_ID } from "./screenContextProjection";

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

/**
 * FE-32-C：屏幕文字摘录上下文源的出口校验。
 *
 * 与上面的环境摘要源分开授权：`environment.screenTextEnabled` 关着时，
 * 请求装配这一层拿到的是空数组——没有任何摘录能被发出去。
 */
describe("createScreenTextContextSource 出口校验（FE-32-C）", () => {
  function screenResult(capturedAt: number) {
    return {
      schemaVersion: SCREEN_CONTEXT_SCHEMA_VERSION,
      id: `ctx-${capturedAt}`,
      sourceId: SCREEN_CONTEXT_SOURCE_ID,
      sourceTrust: "environment",
      captureGeneration: 1,
      sessionGeneration: 1,
      reason: "manual",
      window: { processName: "chrome.exe", windowId: "w1", monitorId: "primary" },
      region: { x: 0, y: 0, width: 10, height: 10 },
      capturedMonotonicMs: capturedAt,
      expiresAtMonotonicMs: capturedAt + 60_000,
      language: "zh",
      confidence: 0.9,
      readStatus: "ok",
      excerpts: [{ order: 0, text: "页面上的一段中文", confidence: 0.9, truncated: false }],
      truncated: false,
      retryAtMonotonicMs: null,
    } as const;
  }

  it("未授权 → 零摘录；授权 → 带来源的受限摘录", async () => {
    const clock = createManualClock(1000);
    let authorized = false;
    const source = createScreenTextContextSource({
      current: () => screenResult(1000),
      getScreenTextEnabled: async () => authorized,
      clock,
    });
    expect(await source.load({})).toEqual([]);

    authorized = true;
    const snippets = await source.load({});
    expect(snippets).toHaveLength(1);
    expect(snippets[0].source).toBe(SCREEN_CONTEXT_SOURCE_ID);
    expect(snippets[0].content).toContain("页面上的一段中文");
    expect(snippets[0].precision).toBe("proxy");
  });

  it("没有当前上下文 / 已过期 → 零摘录，且不去读授权（不做无谓的库访问）", async () => {
    const clock = createManualClock(1000);
    let reads = 0;
    const empty = createScreenTextContextSource({
      current: () => null,
      getScreenTextEnabled: async () => {
        reads += 1;
        return true;
      },
      clock,
    });
    expect(await empty.load({})).toEqual([]);
    expect(reads).toBe(0);

    clock.advance(60_000);
    const expired = createScreenTextContextSource({
      current: (now) => (now >= 61_000 ? null : screenResult(1000)),
      getScreenTextEnabled: async () => true,
      clock,
    });
    expect(await expired.load({})).toEqual([]);
  });

  it("授权读取期间上下文被撤销/刷新 → 不发旧摘录", async () => {
    const clock = createManualClock(1000);
    let generation = 0;
    const source = createScreenTextContextSource({
      current: () => (generation === 0 ? screenResult(1000) : null),
      getScreenTextEnabled: async () => {
        // 模拟「读授权这段等待里用户按了暂停」。
        generation = 1;
        return true;
      },
      clock,
    });
    expect(await source.load({})).toEqual([]);
  });

  it("授权读取抛错按未授权处理（fail-closed）", async () => {
    const clock = createManualClock(1000);
    const source = createScreenTextContextSource({
      current: () => screenResult(1000),
      getScreenTextEnabled: async () => {
        throw new Error("storage broken");
      },
      clock,
    });
    expect(await source.load({})).toEqual([]);
  });
});
