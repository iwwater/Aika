import { describe, expect, it } from "vitest";
import { TRACE_SCHEMA_VERSION, type TraceEventV1 } from "../domain/trace";
import { SETTING_KEYS } from "../services/storage/contracts";
import type { AikaStorage } from "../services/storage/contracts";
import { createMemoryTraceSink } from "../services/trace/memoryTraceSink";
import { createTraceSettings } from "../services/trace/traceSettings";
import type { TraceSink } from "../services/trace/contracts";
import { createDevToolsPresenter } from "./devToolsPresenter";

const AT = 1_700_000_000_000;

function turn(turnId: string, startedAt: number): TraceEventV1[] {
  return [
    {
      schemaVersion: TRACE_SCHEMA_VERSION, turnId, seq: 1, at: startedAt,
      kind: "turn_start", source: "text", mode: "daily", text: null,
    },
    {
      schemaVersion: TRACE_SCHEMA_VERSION, turnId, seq: 2, at: startedAt + 500,
      kind: "turn_end", status: "completed", durationMs: 500,
      tokens: { estimatedPrompt: 800, reportedTotal: null },
    },
  ];
}

/** 只实现工作台用得到的两个方法；其余按 AikaStorage 的形状补最小实现。 */
function fakeStorage(initial: Record<string, string> = {}) {
  const settings = new Map(Object.entries(initial));
  const storage = {
    kind: "local" as const,
    listMessages: async () => [],
    appendMessage: async () => undefined,
    listMessageTimestamps: async () => [],
    countMessagesSince: async () => 0,
    countProactiveSince: async () => 0,
    deleteMessages: async () => undefined,
    clearMessages: async () => undefined,
    listMemories: async () => [],
    addMemories: async () => undefined,
    setMemoryStatus: async () => undefined,
    deleteMemory: async () => undefined,
    latestSummary: async () => null,
    saveSummary: async () => undefined,
    getSetting: async (key: string) => settings.get(key) ?? null,
    setSetting: async (key: string, value: string) => { settings.set(key, value); },
  } satisfies AikaStorage;
  return { storage, settings };
}

function setup(options: {
  events?: TraceEventV1[];
  stored?: Record<string, string>;
  sink?: TraceSink | null;
  traceDefaults?: { enabled: boolean; includeText: boolean };
} = {}) {
  const sink = options.sink === undefined ? createMemoryTraceSink(100) : options.sink;
  if (sink && options.events) for (const event of options.events) sink.append(event);
  const settings = createTraceSettings(options.traceDefaults ?? { enabled: true, includeText: false });
  const { storage, settings: stored } = fakeStorage(options.stored);
  const presenter = createDevToolsPresenter({
    sink,
    settings,
    loadStorage: async () => storage,
  });
  return { presenter, sink, settings, stored };
}

describe("DevToolsPresenter", () => {
  it("装载后按最近优先列出轮次", async () => {
    const { presenter } = setup({ events: [...turn("old", AT), ...turn("new", AT + 10_000)] });
    await presenter.start();

    const snapshot = presenter.getSnapshot();
    expect(snapshot.available).toBe(true);
    expect(snapshot.turns.map((item) => item.turnId)).toEqual(["new", "old"]);
    expect(snapshot.loading).toBe(false);
    presenter.dispose();
  });

  it("没装 Trace 能力时给出「未启用」而不是空列表", async () => {
    const { presenter } = setup({ sink: null });
    await presenter.start();

    const snapshot = presenter.getSnapshot();
    // 页面据此显示「未启用」。空列表会被读成「有 Trace 但什么都没发生」。
    expect(snapshot.available).toBe(false);
    expect(snapshot.turns).toEqual([]);
    presenter.dispose();
  });

  it("选中一轮给出步骤与只含这一轮的 JSONL", async () => {
    const { presenter } = setup({ events: [...turn("t1", AT), ...turn("t2", AT + 1000)] });
    await presenter.start();

    presenter.select("t1");
    const snapshot = presenter.getSnapshot();
    expect(snapshot.selectedTurnId).toBe("t1");
    expect(snapshot.steps.map((step) => step.offsetMs)).toEqual([0, 500]);
    const lines = snapshot.jsonl.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines.every((line) => (JSON.parse(line) as TraceEventV1).turnId === "t1")).toBe(true);

    presenter.select(null);
    expect(presenter.getSnapshot().jsonl.split("\n")).toHaveLength(4);
    presenter.dispose();
  });

  it("刷新会重新读 sink：新事件出现在列表里", async () => {
    const { presenter, sink } = setup({ events: turn("t1", AT) });
    await presenter.start();
    expect(presenter.getSnapshot().turns).toHaveLength(1);

    for (const event of turn("t2", AT + 5000)) sink!.append(event);
    // 刷新之前不该凭空知道新轮次（本页面是手动取数，不是订阅）。
    expect(presenter.getSnapshot().turns).toHaveLength(1);

    await presenter.refresh();
    expect(presenter.getSnapshot().turns.map((item) => item.turnId)).toEqual(["t2", "t1"]);
    presenter.dispose();
  });

  it("sink 查询抛错时报出来，不把页面清空", async () => {
    const broken: TraceSink = {
      append: () => undefined,
      tail: async () => [],
      query: async () => { throw new Error("库锁住了"); },
      flush: async () => undefined,
    };
    const { presenter } = setup({ sink: broken });
    await presenter.start();

    expect(presenter.getSnapshot().error).toContain("库锁住了");
    expect(presenter.getSnapshot().loading).toBe(false);
    presenter.dispose();
  });

  it("启动时把库里的开关灌回服务，库里没写过才用默认值", async () => {
    const withStored = setup({
      stored: { [SETTING_KEYS.traceEnabled]: "0", [SETTING_KEYS.devMode]: "1" },
      traceDefaults: { enabled: true, includeText: false },
    });
    await withStored.presenter.start();

    // 库里说关，就以库里为准——默认值只在没写过时生效。
    expect(withStored.settings.get().enabled).toBe(false);
    expect(withStored.presenter.getSnapshot().traceEnabled).toBe(false);
    expect(withStored.presenter.getSnapshot().devMode).toBe(true);
    withStored.presenter.dispose();

    const fresh = setup({ traceDefaults: { enabled: true, includeText: false } });
    await fresh.presenter.start();
    expect(fresh.settings.get().enabled).toBe(true);
    expect(fresh.presenter.getSnapshot().devMode).toBe(false);
    fresh.presenter.dispose();
  });

  it("三个开关都落库，并立刻反映在服务与快照上", async () => {
    const { presenter, settings, stored } = setup();
    await presenter.start();

    await presenter.setDevMode(true);
    await presenter.setTraceEnabled(false);
    await presenter.setTraceIncludeText(true);

    expect(stored.get(SETTING_KEYS.devMode)).toBe("1");
    expect(stored.get(SETTING_KEYS.traceEnabled)).toBe("0");
    expect(stored.get(SETTING_KEYS.traceIncludeText)).toBe("1");
    // 服务是 recorder 每次记录都读的那一份：改了它才算真的生效。
    expect(settings.get()).toEqual({ enabled: false, includeText: true });
    expect(presenter.getSnapshot()).toMatchObject({
      devMode: true, traceEnabled: false, traceIncludeText: true,
    });
    presenter.dispose();
  });

  it("订阅者在刷新时被通知；dispose 之后不再收到", async () => {
    const { presenter } = setup({ events: turn("t1", AT) });
    let calls = 0;
    const unsubscribe = presenter.subscribe(() => { calls += 1; });
    await presenter.start();
    expect(calls).toBeGreaterThan(0);

    unsubscribe();
    const before = calls;
    await presenter.refresh();
    expect(calls).toBe(before);
    presenter.dispose();
  });
});
