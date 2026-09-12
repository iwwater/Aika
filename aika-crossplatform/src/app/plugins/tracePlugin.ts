import type { AikaPlugin } from "../../kernel";
import { StorageToken } from "../../services/storage/tokens";
import { ClockToken } from "../../services/time/tokens";
import { createMemoryTraceSink } from "../../services/trace/memoryTraceSink";
import { createSqliteTraceSink } from "../../services/trace/sqliteTraceSink";
import { createTraceRecorder } from "../../services/trace/traceRecorder";
import { createObservableTraceSink } from "../../services/trace/observableSink";
import { TraceRecorderToken, TraceSettingsToken, TraceSinkToken } from "../../services/trace/tokens";
import { createTraceSettings, type TraceSettings } from "../../services/trace/traceSettings";
import type { TraceSink } from "../../services/trace/contracts";
import type { TraceEventV1, TraceQuery } from "../../domain/trace";

/**
 * Trace 能力。
 *
 * 装或不装由组合根决定（「能力缺失即 token 不注册」）：关掉 Trace 的构建根本不装
 * 这个插件，消费方 `tryResolve` 拿到 null 就退回 `NO_TRACE`，不需要运行时开关分支。
 *
 * 两个 sink 同时挂上，写两份：内存那份给工作台实时看，落盘那份给「昨天那次是怎么
 * 回事」。它们不是二选一——环形缓冲必然丢最旧的，而落盘查询又太慢，工作台的实时
 * 视图不该每次都去打库。
 */
export interface TracePluginOptions {
  /** 环形缓冲容量。 */
  capacity?: number;
  /** 落盘保留天数。 */
  retentionDays?: number;
  /** 初始开关。持久化的值由设置页在启动后写进这个服务，以库里的为准。 */
  initial?: TraceSettings;
  /** 不落盘（浏览器宿主或不想留痕时）。 */
  memoryOnly?: boolean;
}

/** 写多个 sink 的组合。查询走第一个（内存），它最快且够工作台用。 */
function fanOut(sinks: readonly TraceSink[]): TraceSink {
  return {
    append(event: TraceEventV1) {
      // 一个 sink 出问题不能挡住另一个：各自 fail-open，这里只负责都发一遍。
      for (const sink of sinks) sink.append(event);
    },
    tail: (limit?: number) => sinks[0].tail(limit),
    query: (filter: TraceQuery) => sinks[0].query(filter),
    async flush() {
      for (const sink of sinks) await sink.flush();
    },
  };
}

export function tracePlugin(options: TracePluginOptions = {}): AikaPlugin {
  return {
    id: "llm.trace",
    version: "1.0.0",
    requires: [StorageToken, ClockToken],
    provides: [TraceSinkToken, TraceRecorderToken, TraceSettingsToken],
    async activate(context) {
      const clock = context.registrar.resolve(ClockToken);
      const storage = context.registrar.resolve(StorageToken);
      const memory = createMemoryTraceSink(options.capacity ?? 500);

      const sinks: TraceSink[] = [memory];
      // 落盘需要 SQL 执行器。localStorage 宿主没有，就只留内存那一份——
      // 与其造一个把 JSON 往 localStorage 里堆的假落盘，不如如实少一份。
      const executor = storage.kind === "sqlite" ? storage.sqlExecutor : undefined;
      if (!options.memoryOnly && executor) {
        sinks.push(await createSqliteTraceSink(executor, {
          clock: () => clock.now(),
          ...(options.retentionDays === undefined ? {} : { retentionDays: options.retentionDays }),
        }));
      }

      // 包装成可观察 sink：Live Inspector 订阅先行，查询期间的并发事件才不丢（FE-23）。
      const sink = createObservableTraceSink(sinks.length === 1 ? memory : fanOut(sinks));
      const settings = createTraceSettings(options.initial);
      // 两个闭包每次都重新读：设置页一改，下一条事件就按新规矩走。
      const recorder = createTraceRecorder({
        sink,
        clock: () => clock.now(),
        isEnabled: () => settings.get().enabled,
        policy: () => ({ includeText: settings.get().includeText }),
      });

      context.registrar.provide(TraceSinkToken, () => sink);
      context.registrar.provide(TraceRecorderToken, () => recorder);
      context.registrar.provide(TraceSettingsToken, () => settings);
    },
  };
}
