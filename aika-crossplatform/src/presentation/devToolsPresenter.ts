/**
 * 工作台的 Presenter。
 *
 * 与 React 无关，所以它是这个页面**唯一可测的行为面**（仓库没有 DOM 测试环境）。
 * 页面组件只订阅快照、派发命令。
 *
 * 取数方式是「打开时读 + 手动刷新」：`TraceSink` 没有订阅接口，为了一个调试页给它
 * 加一套推送不值得。真要实时，等 sink 有了订阅能力再说。
 */

import { groupTurns, toJsonl, turnSteps, type TraceStep, type TraceTurnSummary } from "../domain/traceView";
import type { TraceEventV1 } from "../domain/trace";
import type { AikaStorage } from "../services/storage/contracts";
import { SETTING_KEYS } from "../services/storage/contracts";
import type { TraceSink } from "../services/trace/contracts";
import type { TraceSettingsService } from "../services/trace/traceSettings";

export interface DevToolsViewModel {
  /** 没装 Trace 能力时为 false：页面据此显示「未启用」，而不是一个空列表。 */
  available: boolean;
  loading: boolean;
  /** 开发者模式开关（决定标题栏要不要出入口）。 */
  devMode: boolean;
  traceEnabled: boolean;
  traceIncludeText: boolean;
  turns: readonly TraceTurnSummary[];
  selectedTurnId: string | null;
  steps: readonly TraceStep[];
  /** 原始 JSONL。只在选中某一轮时给这一轮的，否则给全部。 */
  jsonl: string;
  error: string;
}

export interface DevToolsPresenter {
  getSnapshot(): DevToolsViewModel;
  subscribe(listener: () => void): () => void;
  /** 幂等：重复调用只装载一次。 */
  start(): Promise<void>;
  refresh(): Promise<void>;
  select(turnId: string | null): void;
  setDevMode(enabled: boolean): Promise<void>;
  setTraceEnabled(enabled: boolean): Promise<void>;
  setTraceIncludeText(enabled: boolean): Promise<void>;
  dispose(): void;
}

export interface DevToolsPresenterDeps {
  /** 没装 Trace 时为 null。 */
  sink: TraceSink | null;
  settings: TraceSettingsService | null;
  loadStorage: () => Promise<AikaStorage>;
  /** 一次读多少条事件。 */
  limit?: number;
}

const DEFAULT_LIMIT = 2000;

export function createDevToolsPresenter(deps: DevToolsPresenterDeps): DevToolsPresenter {
  let listeners = new Set<() => void>();
  let disposed = false;
  let started = false;
  let storage: AikaStorage | null = null;

  let loading = false;
  let devMode = false;
  let events: TraceEventV1[] = [];
  let selectedTurnId: string | null = null;
  let error = "";

  let cached: DevToolsViewModel | null = null;
  let dirty = true;

  function commit(): void {
    dirty = true;
    if (disposed) return;
    for (const listener of [...listeners]) listener();
  }

  function traceSettings() {
    return deps.settings?.get() ?? { enabled: false, includeText: false };
  }

  function getSnapshot(): DevToolsViewModel {
    if (!cached || dirty) {
      const turns = groupTurns(events);
      const scoped = selectedTurnId
        ? events.filter((event) => event.turnId === selectedTurnId)
        : events;
      cached = Object.freeze({
        // 单一来源：有没有 sink 就是有没有 Trace 能力，没有第二处能改它。
        available: Boolean(deps.sink),
        loading,
        devMode,
        traceEnabled: traceSettings().enabled,
        traceIncludeText: traceSettings().includeText,
        turns,
        selectedTurnId,
        steps: selectedTurnId ? turnSteps(events, selectedTurnId) : [],
        jsonl: toJsonl(scoped),
        error,
      });
      dirty = false;
    }
    return cached;
  }

  /** 设置读写都容错：调试页打不开设置，不该让它整页报错。 */
  async function persist(key: string, value: boolean): Promise<void> {
    try {
      storage ??= await deps.loadStorage();
      await storage.setSetting(key, value ? "1" : "0");
    } catch (settingError) {
      error = settingError instanceof Error ? settingError.message : String(settingError);
    }
  }

  async function readFlag(key: string, fallback: boolean): Promise<boolean> {
    try {
      storage ??= await deps.loadStorage();
      const raw = await storage.getSetting(key);
      // 没写过就用默认值（Trace 的默认按构建取，见 traceSettings）。
      return raw === null ? fallback : raw === "1";
    } catch {
      return fallback;
    }
  }

  async function refresh(): Promise<void> {
    if (!deps.sink) {
      commit();
      return;
    }
    loading = true;
    commit();
    try {
      const rows = await deps.sink.query({ limit: deps.limit ?? DEFAULT_LIMIT });
      if (disposed) return;
      events = [...rows];
      error = "";
    } catch (queryError) {
      error = queryError instanceof Error ? queryError.message : String(queryError);
    } finally {
      loading = false;
      commit();
    }
  }

  return {
    getSnapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async start() {
      if (started || disposed) return;
      started = true;
      const current = traceSettings();
      // 持久化的值以库里的为准；LLM-07 只把默认值放进服务，灌回来是这里的事。
      devMode = await readFlag(SETTING_KEYS.devMode, false);
      const enabled = await readFlag(SETTING_KEYS.traceEnabled, current.enabled);
      const includeText = await readFlag(SETTING_KEYS.traceIncludeText, current.includeText);
      deps.settings?.set({ enabled, includeText });
      commit();
      await refresh();
    },
    refresh,
    select(turnId) {
      selectedTurnId = turnId;
      commit();
    },
    async setDevMode(enabled) {
      devMode = enabled;
      commit();
      await persist(SETTING_KEYS.devMode, enabled);
      commit();
    },
    async setTraceEnabled(enabled) {
      deps.settings?.set({ enabled });
      commit();
      await persist(SETTING_KEYS.traceEnabled, enabled);
      commit();
    },
    async setTraceIncludeText(enabled) {
      deps.settings?.set({ includeText: enabled });
      commit();
      await persist(SETTING_KEYS.traceIncludeText, enabled);
      commit();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      listeners = new Set();
    },
  };
}
