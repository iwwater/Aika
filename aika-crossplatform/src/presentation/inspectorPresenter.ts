/**
 * Live Inspector Presenter（FE-23）。
 *
 * 数据纪律是「**订阅先行**」：先注册实时监听、把查询期间的并发事件缓冲住，
 * 再查历史，最后按 turnId+seq 去重合并——先 query 后 subscribe 必然丢事件。
 * sink 没有分页游标，所以历史就是一次有界 tail 快照；超限淘汰如实提示。
 *
 * 设置联动：trace 关闭 → 清空采集视图并退订（重开再订阅），不自行开启；
 * includeText 切换 → 同一 redactTraceEvent 对显示重投影。落盘正文在写入时
 * 已经按当时的开关脱敏过，这里的重投影只管当前显示/导出，不删历史落盘。
 *
 * 隔离规则：实时监听器与 sink 异常相互隔离（同步抛错与异步 rejection 都接）；
 * 快照只读复制，监听器改事件对象不影响落盘与内部视图。
 */

import {
  redactTraceEvent, sortTraceEvents,
  type TraceEventV1, type TraceRedactionPolicy,
} from "../domain/trace";
import type { TraceSink } from "../services/trace/contracts";
import { isObservableTraceSink, type TraceAppendListener } from "../services/trace/observableSink";
import type { TraceSettingsService } from "../services/trace/traceSettings";

export interface InspectorPresenterDeps {
  /** TraceSink（可观察包装由 tracePlugin 装好）；没装 Trace 能力时为 null。 */
  sink: TraceSink | null;
  settings: TraceSettingsService | null;
}

export type InspectorHistoryStatus = "idle" | "loading" | "ready" | "unavailable";

export interface InspectorViewModel {
  traceEnabled: boolean;
  includeText: boolean;
  historyStatus: InspectorHistoryStatus;
  /** 当前显示的事件（已按当前 includeText 投影；turnId+seq 升序）。 */
  events: readonly TraceEventV1[];
  /** 淘汰/截断提示；没有淘汰时为 null。 */
  evictionNote: string | null;
  /** includeText=false 时的提示：这是显示屏蔽，不删除历史落盘正文。 */
  maskingNote: boolean;
}

export interface InspectorPresenter {
  /** 打开采集视图：订阅先行，随后查历史合并。幂等。 */
  open(): Promise<void>;
  /** 关闭：退订全部监听，迟到的查询结果作废。 */
  close(): void;
  getSnapshot(): InspectorViewModel;
  subscribe(listener: () => void): () => void;
}

const MAX_EVENTS = 5000;
const MAX_TURNS = 50;
/** 正文之外的内存上限：5000 条事件不等于 5000 条小对象，字节也得上限。 */
const MAX_BYTES = 512_000;

function eventBytes(event: TraceEventV1): number {
  return JSON.stringify(event).length;
}

export function createInspectorPresenter(deps: InspectorPresenterDeps): InspectorPresenter {
  const settings = deps.settings;

  let disposed = false;
  let opened = false;
  /** 会话代号：close/重开都 +1；迟到的查询结果对不上号就丢弃。 */
  let session = 0;
  let historyStatus: InspectorHistoryStatus = "idle";
  let evictionNote: string | null = null;

  /** 原始事件（写入时已按当时策略脱敏）；显示时按当前策略再投影。 */
  let store: TraceEventV1[] = [];
  /** 历史查询期间的实时事件缓冲；合并后清空。 */
  let pending: TraceEventV1[] = [];
  let historyReady = false;

  let unsubscribeSink: (() => void) | null = null;
  /** 设置订阅随 Presenter 生命周期存在（构造期建立），退订函数无需保留。 */

  let cached: InspectorViewModel | null = null;
  let dirty = true;
  let listeners = new Set<() => void>();

  // 设置订阅在构造期建立、随 Presenter 生命周期存在（dispose 为止）：
  // Trace 关着时也要能「看到重新打开」并恢复采集，而不是永远停在引导页。
  if (settings) {
    settings.onChanged(handleSettingsChange);
  }

  function commit(): void {
    dirty = true;
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // UI 订阅者抛错不影响采集。
      }
    }
  }

  function eventKey(event: TraceEventV1): string {
    return `${event.turnId}:${event.seq}`;
  }

  /** 去重合并 + 有界淘汰。实时与历史同源同键，重复的天然落掉。 */
  function mergeEvents(incoming: readonly TraceEventV1[]): void {
    if (!incoming.length) return;
    const byKey = new Map<string, TraceEventV1>();
    for (const event of store) byKey.set(eventKey(event), event);
    for (const event of incoming) {
      const key = eventKey(event);
      if (!byKey.has(key)) byKey.set(key, event);
    }
    const sorted = sortTraceEvents([...byKey.values()]);

    // 有界淘汰：从最新往回保留 50 轮 / 5000 条 / 字节上限；超限如实提示。
    const turns = new Set<string>();
    const kept: TraceEventV1[] = [];
    let bytes = 0;
    let dropped = 0;
    for (let index = sorted.length - 1; index >= 0; index -= 1) {
      const event = sorted[index];
      const cost = eventBytes(event);
      if (kept.length >= MAX_EVENTS || bytes + cost > MAX_BYTES) {
        dropped = index + 1;
        break;
      }
      if (!turns.has(event.turnId)) {
        if (turns.size >= MAX_TURNS) {
          dropped = index + 1;
          break;
        }
        turns.add(event.turnId);
      }
      bytes += cost;
      kept.push(event);
    }
    kept.reverse();
    evictionNote = dropped > 0
      ? `容量已满：只保留最近 ${turns.size} 轮 / ${kept.length} 条，更早的 ${dropped} 条已被淘汰（落盘历史不受影响）。`
      : null;
    store = kept;
  }

  const onLiveEvent: TraceAppendListener = (event) => {
    if (disposed || !opened || !historyReady) {
      // 历史还没就绪：先缓冲。监听器拿到的是副本，改它不落库、不污染视图。
      pending.push({ ...event });
      return;
    }
    mergeEvents([event]);
    commit();
  };

  function handleSettingsChange(next: { enabled: boolean; includeText: boolean }): void {
    if (disposed) return;
    if (!next.enabled) {
      // 关闭采集：清视图 + 退订 sink；视图保持「开着」继续显示引导。
      // 不自行帮用户开 Trace；重开时由 enable 分支恢复采集。
      session += 1;
      unsubscribeSink?.();
      unsubscribeSink = null;
      historyReady = false;
      pending = [];
      store = [];
      historyStatus = "idle";
      commit();
      return;
    }
    if (!opened) return; // 视图关着：不自动打开；用户重开视图时自然 open()。
    if (!historyReady) {
      // 视图开着但还没采集（刚被禁用拆掉/正在载入）：重走订阅先行流程。
      void presenter.open();
      return;
    }
    // includeText 变化：显示层重投影在 getSnapshot 里按当前策略做，这里只需刷新。
    commit();
  }

  const presenter: InspectorPresenter = {
    async open(): Promise<void> {
      if (disposed || !deps.sink || !settings) return;
      const current = settings.get();
      if (!current.enabled) {
        // Trace 关着：视图算「开着」（显示引导），但不订阅不采集，也不自行开启。
        // 用户在工作台把 Trace 打开后，handleSettingsChange 会恢复采集。
        opened = true;
        historyStatus = "idle";
        commit();
        return;
      }
      // 幂等闸：已经在采集（载入中或就绪）就不重复订阅。
      if (historyStatus === "loading" || historyReady) {
        opened = true;
        return;
      }
      opened = true;
      session += 1;
      const mySession = session;

      // 1) 订阅先行：并发事件进缓冲，绝不先查后订。
      if (isObservableTraceSink(deps.sink)) {
        unsubscribeSink?.();
        unsubscribeSink = deps.sink.onAppend(onLiveEvent);
      }

      // 2) 有界 tail 历史快照；查询期间的并发事件在 pending 里等着合并。
      historyStatus = "loading";
      commit();
      let history: readonly TraceEventV1[];
      try {
        history = await deps.sink.tail(MAX_EVENTS);
      } catch {
        // 查询失败：仍接实时，历史显式标不可用。
        if (disposed || session !== mySession) return;
        historyStatus = "unavailable";
        historyReady = true;
        const buffered = pending;
        pending = [];
        mergeEvents(buffered);
        commit();
        return;
      }
      if (disposed || session !== mySession) return; // 迟到的查询不污染新快照。

      // 3) 合并：历史 + 缓冲去重排序。
      historyReady = true;
      const buffered = pending;
      pending = [];
      mergeEvents([...history, ...buffered]);
      historyStatus = "ready";
      commit();
    },

    close(): void {
      if (!opened) return;
      opened = false;
      session += 1; // 迟到的查询结果对不上号，直接作废。
      unsubscribeSink?.();
      unsubscribeSink = null;
      // settings 订阅随 Presenter 生命周期保留：重开视图仍能感知设置变化。
      historyReady = false;
      pending = [];
      store = [];
      historyStatus = "idle";
      commit();
    },

    getSnapshot(): InspectorViewModel {
      if (!cached || dirty) {
        const currentIncludeText = settings?.get().includeText ?? false;
        const policy: TraceRedactionPolicy = { includeText: currentIncludeText };
        cached = Object.freeze({
          traceEnabled: settings?.get().enabled ?? false,
          includeText: currentIncludeText,
          historyStatus,
          // 只读投影：副本数组 + redactTraceEvent 生成新对象，监听器改不动内部视图。
          events: Object.freeze(store.map((event) => redactTraceEvent(event, policy))),
          evictionNote,
          maskingNote: !currentIncludeText && store.length > 0,
        });
        dirty = false;
      }
      return cached;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };

  return presenter;
}
