import { describe, expect, it, vi } from "vitest";
import { createInspectorPresenter } from "./inspectorPresenter";
import { createMemoryTraceSink } from "../services/trace/memoryTraceSink";
import { createObservableTraceSink, type ObservableTraceSink } from "../services/trace/observableSink";
import { createTraceSettings } from "../services/trace/traceSettings";
import type { TraceEventV1, TraceQuery } from "../domain/trace";
import type { TraceSink } from "../services/trace/contracts";

/**
 * FE-23 Presenter 契约：合并不丢不重、异常相互隔离、设置联动与关闭零泄漏。
 * sink 用真实 memoryTraceSink + observable 包装（都是生产实现），只 fake 时序与存储内容。
 */

function event(turnId: string, seq: number, kind: TraceEventV1["kind"] = "turn_start", extra: Partial<TraceEventV1> = {}): TraceEventV1 {
  return {
    schemaVersion: 1, turnId, seq, at: 1_788_998_400_000 + seq, kind,
    ...extra,
  } as TraceEventV1;
}

function flush(times = 8): Promise<void> {
  let chain = Promise.resolve();
  for (let index = 0; index < times; index += 1) chain = chain.then(() => undefined);
  return chain;
}

describe("FE-23-A 合并：查询期间并发到达不丢不重", () => {
  it("订阅先行：tail 慢的时候，查询期间到达的事件合并后恰好一次", async () => {
    const inner = createMemoryTraceSink(100);
    const release: { tail?: (events: readonly TraceEventV1[]) => void } = {};
    // 用「查询被人为挂起」的包装模拟历史查询与实时到达的并发。
    const slow: TraceSink = {
      append: (event) => inner.append(event),
      tail: () => new Promise((resolve) => {
        release.tail = (events) => resolve(events);
      }),
      query: (filter: TraceQuery) => inner.query(filter),
      flush: () => inner.flush(),
    };
    const sink = createObservableTraceSink(slow);
    const settings = createTraceSettings({ enabled: true, includeText: true });
    const presenter = createInspectorPresenter({ sink, settings });

    // 查询前先落一条历史。
    inner.append(event("t1", 1));
    const opening = presenter.open();
    await flush();
    // 查询挂起期间并发到达：走实时缓冲。
    sink.append(event("t2", 1));
    sink.append(event("t1", 2));
    release.tail?.([event("t1", 1)]);
    await opening;

    const { events } = presenter.getSnapshot();
    const keys = events.map((entry) => `${entry.turnId}:${entry.seq}`).sort();
    expect(keys).toEqual(["t1:1", "t1:2", "t2:1"]);
    expect(events.filter((entry) => entry.turnId === "t1")).toHaveLength(2);
    expect(presenter.getSnapshot().historyStatus).toBe("ready");
  });

  it("关窗后迟到的查询结果不污染新快照", async () => {
    const inner = createMemoryTraceSink(100);
    const release: { tail?: (events: readonly TraceEventV1[]) => void } = {};
    let firstTail = true;
    const slow: TraceSink = {
      append: (event) => inner.append(event),
      tail: () => {
        if (!firstTail) return inner.tail();
        firstTail = false;
        return new Promise((resolve) => {
          release.tail = (events) => resolve(events);
        });
      },
      query: (filter: TraceQuery) => inner.query(filter),
      flush: () => inner.flush(),
    };
    const sink = createObservableTraceSink(slow);
    const settings = createTraceSettings({ enabled: true, includeText: true });
    const presenter = createInspectorPresenter({ sink, settings });

    inner.append(event("stale", 1));
    const opening = presenter.open();
    await flush();
    presenter.close();
    // 迟到的历史结果此时才到：作废。
    release.tail?.([event("stale", 1), event("stale", 2)]);
    await opening;
    expect(presenter.getSnapshot().events).toHaveLength(0);
    expect(presenter.getSnapshot().historyStatus).toBe("idle");

    // 重新打开：stale:2（从未落盘、只在被作废的查询结果里）不能出现；
    // stale:1 是真实落盘历史，重开后自然可见。
    inner.append(event("fresh", 1));
    await presenter.open();
    const keys = presenter.getSnapshot().events.map((entry) => `${entry.turnId}:${entry.seq}`);
    expect(keys).toContain("fresh:1");
    expect(keys).toContain("stale:1");
    expect(keys).not.toContain("stale:2");
  });
});

describe("FE-23-B 隔离与零泄漏", () => {
  it("监听器同步抛错与异步 rejection 都被隔离，不影响其他监听器与 Presenter", async () => {
    const sink = createObservableTraceSink(createMemoryTraceSink(100));
    const settings = createTraceSettings({ enabled: true, includeText: true });
    const good = vi.fn();
    sink.onAppend(() => {
      throw new Error("同步崩");
    });
    sink.onAppend(() => Promise.reject(new Error("异步崩")));
    sink.onAppend(good);
    const presenter = createInspectorPresenter({ sink, settings });
    await presenter.open();

    sink.append(event("t1", 1));
    await flush();
    expect(good).toHaveBeenCalled();
    expect(presenter.getSnapshot().events).toHaveLength(1);
  });

  it("关闭后零订阅泄漏：append 不再进入视图", async () => {
    const sink = createObservableTraceSink(createMemoryTraceSink(100));
    const settings = createTraceSettings({ enabled: true, includeText: true });
    const presenter = createInspectorPresenter({ sink, settings });
    await presenter.open();
    sink.append(event("t1", 1));
    await flush();
    expect(presenter.getSnapshot().events).toHaveLength(1);

    presenter.close();
    sink.append(event("t2", 1));
    await flush();
    expect(presenter.getSnapshot().events).toHaveLength(0);
  });

  it("恶意监听器改事件对象：不影响落盘与 Presenter 视图", async () => {
    const inner = createMemoryTraceSink(100);
    const sink: ObservableTraceSink = createObservableTraceSink(inner);
    sink.onAppend((event) => {
      (event as { turnId: string }).turnId = "hacked";
    });
    const settings = createTraceSettings({ enabled: true, includeText: true });
    const presenter = createInspectorPresenter({ sink, settings });
    await presenter.open();
    sink.append(event("real", 1));
    await flush();
    expect(presenter.getSnapshot().events[0].turnId).toBe("real");
    // 落盘的也是原始值。
    const stored = await inner.query({});
    expect(stored[0].turnId).toBe("real");
  });
});

describe("FE-23-C 设置联动", () => {
  it("Trace 关闭：显示引导（不自行开启）；重新开启自动恢复采集", async () => {
    const sink = createObservableTraceSink(createMemoryTraceSink(100));
    const settings = createTraceSettings({ enabled: false, includeText: true });
    const presenter = createInspectorPresenter({ sink, settings });
    await presenter.open();
    expect(presenter.getSnapshot().traceEnabled).toBe(false);
    expect(presenter.getSnapshot().historyStatus).toBe("idle");

    sink.append(event("t1", 1));
    await flush();
    expect(presenter.getSnapshot().events).toHaveLength(0);

    settings.set({ enabled: true });
    await flush();
    sink.append(event("t2", 1));
    await flush();
    expect(presenter.getSnapshot().traceEnabled).toBe(true);
    // t2 经实时订阅进来；t1 是 sink 里真实存在的历史（fixture 直写 sink），
    // 重新查询带上它反而是「合并历史」的正确行为。
    expect(presenter.getSnapshot().events.map((entry) => entry.turnId)).toContain("t2");
  });

  it("includeText 切换：同一 redact 函数重投影历史；false 时显示屏蔽不冒充删除", async () => {
    const sink = createObservableTraceSink(createMemoryTraceSink(100));
    const settings = createTraceSettings({ enabled: true, includeText: true });
    const presenter = createInspectorPresenter({ sink, settings });
    await presenter.open();
    sink.append(event("t1", 1, "turn_start", { source: "text", mode: "companion", text: "带正文的用户原话" }));
    await flush();
    const before = presenter.getSnapshot().events[0];
    expect(before.kind === "turn_start" && before.text).toBe("带正文的用户原话");

    settings.set({ includeText: false });
    await flush();
    const masked = presenter.getSnapshot().events[0];
    expect(masked.kind === "turn_start" ? masked.text : null).toBeNull();
    expect(presenter.getSnapshot().maskingNote).toBe(true);

    settings.set({ includeText: true });
    await flush();
    const restored = presenter.getSnapshot().events[0];
    expect(restored.kind === "turn_start" && restored.text).toBe("带正文的用户原话");
  });
});
