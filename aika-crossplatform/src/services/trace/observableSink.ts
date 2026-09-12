/**
 * 可观察 Trace sink（FE-23）。
 *
 * Live Inspector 需要「订阅先行」：注册监听后再查历史，增量与历史按
 * turnId+seq 合并，查询期间的并发事件才不会丢。sink 本身没有订阅 API，
 * 所以在组合根用这层包装：append 仍然先落真实 sink，随后通知监听器。
 *
 * 隔离规则：监听器的同步抛错与异步 rejection 都被捕获——一个 UI 订阅者
 * 崩溃不能挡住落盘，也不能挡住其它订阅者；事件对象以只读副本交给监听器，
 * 监听器改它不影响落盘也不影响 Presenter 的内部视图。
 */

import type { TraceEventV1 } from "../../domain/trace";
import type { TraceSink } from "./contracts";

export type TraceAppendListener = (event: TraceEventV1) => void;

export interface ObservableTraceSink extends TraceSink {
  /** 注册实时事件监听；返回退订函数。 */
  onAppend(listener: TraceAppendListener): () => void;
}

export function createObservableTraceSink(inner: TraceSink): ObservableTraceSink {
  const listeners = new Set<TraceAppendListener>();

  function notify(event: TraceEventV1): void {
    for (const listener of [...listeners]) {
      try {
        // 每个监听器一份独立副本：一个监听器改事件，不影响落盘与其它监听器。
        const result = listener({ ...event }) as unknown;
        // 异步监听器的 rejection 也要接住：同步 try/catch 管不到它。
        if (result instanceof Promise) result.catch(() => undefined);
      } catch {
        // 同步抛错同理：隔离，不传播。
      }
    }
  }

  return {
    append(event) {
      inner.append(event);
      notify(event);
    },
    tail: (limit?: number) => inner.tail(limit),
    query: (filter) => inner.query(filter),
    flush: () => inner.flush(),
    onAppend(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** 类型守卫：插件里装好的 sink 是否带订阅能力。 */
export function isObservableTraceSink(sink: TraceSink): sink is ObservableTraceSink {
  return typeof (sink as ObservableTraceSink).onAppend === "function";
}
