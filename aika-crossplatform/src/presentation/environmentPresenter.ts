import {
  type EnvironmentMonitor,
  type EnvironmentSourceState,
} from "../services/environment/contracts";
import { FOREGROUND_SOURCE_ID } from "../services/environment/foregroundSource";
import { SCREEN_SOURCE_ID } from "../services/environment/screenSource";
import { SETTING_ENVIRONMENT_CONTEXT_ENABLED } from "../services/environment/contextSource";
import { SETTING_SCREEN_TEXT_ENABLED } from "../services/environment/screenContextSource";
import { SETTING_KEYS } from "../services/storage/contracts";

/**
 * 环境感知设置 Presenter（FE-19 2026-09-14 修订第 2/3 条）。
 *
 * 职责：每源开关、状态订阅、「停止全部」。Hook 只看快照，不 import 服务实现。
 * 与 React 无关（架构门禁）。
 *
 * 授权语义：
 * - 采集开关与「将环境摘要用于对话」是两个独立设置，互不隐式开启。
 * - **关闭动作先执行内存撤销，再尝试持久化**——存储失败不能让采集继续。
 * - 「停止全部感知」先撤销 monitor generation、关掉摘要使用、清缓存，
 *   然后等资源释放；不得只关 UI 开关。
 * - 启动时设置读取失败按关闭处理。
 */

export const SETTING_ENVIRONMENT_FOREGROUND_ENABLED = "environment.foregroundEnabled";

export interface EnvironmentSourceView {
  sourceId: string;
  /** 显示名；FE-21 加 screen 源时由同一状态通道带出。 */
  label: string;
  state: EnvironmentSourceState;
  enabled: boolean;
  /** 仅代码，不含传感器内部正文。 */
  error: string | null;
}

export interface EnvironmentPresenterView {
  /** 本宿主没有环境能力（无 monitor）时为 false：设置分组隐藏。 */
  available: boolean;
  sources: readonly EnvironmentSourceView[];
  contextEnabled: boolean;
  /** 「允许环境主动搭话」（FE-22）：与全局 proactive、摘要授权分层。 */
  proactiveEnabled: boolean;
  /**
   * 「允许屏幕文字用于对话」（FE-32）：又一层独立授权。
   *
   * 它放行的不是摘要，而是屏幕上可见文字的**受限摘录**；与采集开关、摘要授权
   * 三者互不隐式开启。关闭时请求装配那一层拿到零摘录。
   */
  screenTextEnabled: boolean;
  /** stopAll 进行中：真实的停止等待期，不是装饰态。 */
  stopping: boolean;
  error: string | null;
}

export interface EnvironmentSettingsPort {
  getBoolean(key: string, fallback: boolean): Promise<boolean>;
  setBoolean(key: string, value: boolean): Promise<void>;
}

export interface EnvironmentPresenterDeps {
  monitor: EnvironmentMonitor | null;
  /** 持久化端口；缺省时开关只在内存生效且不可写（浏览器 dev 宿主）。 */
  settings?: EnvironmentSettingsPort | null;
}

export interface EnvironmentPresenter {
  start(): Promise<void>;
  getSnapshot(): EnvironmentPresenterView;
  subscribe(listener: () => void): () => void;
  setSourceEnabled(sourceId: string, enabled: boolean): Promise<void>;
  setContextEnabled(enabled: boolean): Promise<void>;
  setProactiveEnabled(enabled: boolean): Promise<void>;
  setScreenTextEnabled(enabled: boolean): Promise<void>;
  stopAll(): Promise<void>;
  dispose(): void;
}

const SOURCE_LABELS: Record<string, string> = {
  [FOREGROUND_SOURCE_ID]: "前台应用感知",
  [SCREEN_SOURCE_ID]: "屏幕感知",
};

/** 每源独立设置键；采集开关互不牵连（SET-01）。 */
const SOURCE_SETTING_KEYS: Record<string, string> = {
  [FOREGROUND_SOURCE_ID]: SETTING_KEYS.environmentForegroundEnabled,
  [SCREEN_SOURCE_ID]: SETTING_KEYS.environmentScreenEnabled,
};

function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createEnvironmentPresenter(deps: EnvironmentPresenterDeps): EnvironmentPresenter {
  const { monitor } = deps;
  const settings = deps.settings ?? null;

  let contextEnabled = false;
  let proactiveEnabled = false;
  let screenTextEnabled = false;
  let stopping = false;
  let error: string | null = null;
  let started = false;
  const listeners = new Set<() => void>();
  let unsubscribeState: (() => void) | null = null;
  let disposed = false;
  // useSyncExternalStore 要求「状态没变返回同一个对象」：视图只在 commit 时重建。
  let view: EnvironmentPresenterView = {
    available: monitor !== null,
    sources: [],
    contextEnabled,
    proactiveEnabled,
    screenTextEnabled,
    stopping,
    error,
  };

  function commit(): void {
    view = {
      available: monitor !== null,
      sources: sourceViews(),
      contextEnabled,
      proactiveEnabled,
      screenTextEnabled,
      stopping,
      error,
    };
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // 界面订阅者异常不影响状态机。
      }
    }
  }

  function sourceViews(): readonly EnvironmentSourceView[] {
    if (!monitor) return [];
    return monitor.statuses().map((status) => ({
      sourceId: status.sourceId,
      label: SOURCE_LABELS[status.sourceId] ?? status.sourceId,
      state: status.state,
      enabled: status.state === "running" || status.state === "starting" || status.state === "stopping",
      error: status.error,
    }));
  }

  const presenter: EnvironmentPresenter = {
    async start(): Promise<void> {
      if (!monitor || disposed || started) return;
      started = true;
      unsubscribeState = monitor.onStateChange(() => commit());
      // 启动读取失败按关闭处理（fail-closed，不自动开启采集）。
      try {
        contextEnabled = settings
          ? await settings.getBoolean(SETTING_ENVIRONMENT_CONTEXT_ENABLED, false)
          : false;
      } catch {
        contextEnabled = false;
      }
      try {
        proactiveEnabled = settings
          ? await settings.getBoolean(SETTING_KEYS.environmentProactiveEnabled, false)
          : false;
      } catch {
        proactiveEnabled = false;
      }
      try {
        screenTextEnabled = settings
          ? await settings.getBoolean(SETTING_SCREEN_TEXT_ENABLED, false)
          : false;
      } catch {
        screenTextEnabled = false;
      }
      const pending: Array<{ sourceId: string; enabled: boolean }> = [];
      for (const [sourceId, settingKey] of Object.entries(SOURCE_SETTING_KEYS)) {
        let enabled = false;
        try {
          enabled = settings ? await settings.getBoolean(settingKey, false) : false;
        } catch {
          enabled = false;
        }
        pending.push({ sourceId, enabled });
      }
      commit();
      for (const { sourceId, enabled } of pending) {
        if (!enabled) continue;
        try {
          await monitor.setSourceEnabled(sourceId, true);
        } catch (caught) {
          error = detailOf(caught);
        }
        commit();
      }
    },

    getSnapshot(): EnvironmentPresenterView {
      return view;
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async setSourceEnabled(sourceId: string, enabled: boolean): Promise<void> {
      if (!monitor) return;
      const settingKey = SOURCE_SETTING_KEYS[sourceId];
      if (!settingKey) {
        error = `unknown source: ${sourceId}`;
        commit();
        return;
      }
      if (enabled) {
        // 开启：先持久化同意，再启动采集。写失败就不采集（没有落库的同意不开采集）。
        try {
          await settings?.setBoolean(settingKey, true);
        } catch (caught) {
          error = `设置保存失败：${detailOf(caught)}`;
          commit();
          return;
        }
        try {
          await monitor.setSourceEnabled(sourceId, true);
        } catch (caught) {
          error = detailOf(caught);
        }
        commit();
        return;
      }
      // 关闭：先内存撤销，再持久化；存储失败不能继续外发（错误可见）。
      try {
        await monitor.setSourceEnabled(sourceId, false);
      } catch (caught) {
        error = detailOf(caught);
        commit();
        return;
      }
      try {
        await settings?.setBoolean(settingKey, false);
      } catch (caught) {
        error = `设置保存失败：${detailOf(caught)}`;
      }
      commit();
    },

    async setContextEnabled(enabled: boolean): Promise<void> {
      // 摘要授权只影响「是否随请求外发」，不触碰传感器状态。
      if (enabled) {
        try {
          await settings?.setBoolean(SETTING_ENVIRONMENT_CONTEXT_ENABLED, true);
        } catch (caught) {
          error = `设置保存失败：${detailOf(caught)}`;
          commit();
          return;
        }
        contextEnabled = true;
        commit();
        return;
      }
      // 关闭：先撤销内存授权（立即停止外发），再持久化。
      contextEnabled = false;
      commit();
      try {
        await settings?.setBoolean(SETTING_ENVIRONMENT_CONTEXT_ENABLED, false);
      } catch (caught) {
        error = `设置保存失败：${detailOf(caught)}`;
      }
      commit();
    },

    async setProactiveEnabled(enabled: boolean): Promise<void> {
      // 环境主动开关：开启先持久化再生效；关闭先撤销内存（立即停止新候选）再持久化。
      if (enabled) {
        try {
          await settings?.setBoolean(SETTING_KEYS.environmentProactiveEnabled, true);
        } catch (caught) {
          error = `设置保存失败：${detailOf(caught)}`;
          commit();
          return;
        }
        proactiveEnabled = true;
        commit();
        return;
      }
      proactiveEnabled = false;
      commit();
      try {
        await settings?.setBoolean(SETTING_KEYS.environmentProactiveEnabled, false);
      } catch (caught) {
        error = `设置保存失败：${detailOf(caught)}`;
      }
      commit();
    },

    async setScreenTextEnabled(enabled: boolean): Promise<void> {
      // 文字摘录授权：开启先落库再生效；关闭先撤销内存（下一次请求装配立刻为空）
      // 再持久化——存储失败不能让摘录继续外发。
      if (enabled) {
        try {
          await settings?.setBoolean(SETTING_SCREEN_TEXT_ENABLED, true);
        } catch (caught) {
          error = `设置保存失败：${detailOf(caught)}`;
          commit();
          return;
        }
        screenTextEnabled = true;
        commit();
        return;
      }
      screenTextEnabled = false;
      commit();
      try {
        await settings?.setBoolean(SETTING_SCREEN_TEXT_ENABLED, false);
      } catch (caught) {
        error = `设置保存失败：${detailOf(caught)}`;
      }
      commit();
    },

    async stopAll(): Promise<void> {
      if (!monitor) return;
      stopping = true;
      commit();
      try {
        // 1. 撤销 monitor generation、停采集（等待资源释放）。
        await monitor.stopAll();
        // 2. 关闭摘要使用、环境主动与屏幕文字摘录（内存立即生效）。
        contextEnabled = false;
        proactiveEnabled = false;
        screenTextEnabled = false;
        commit();
        // 3. 持久化关闭；失败可见但不回滚内存状态。
        try {
          for (const settingKey of Object.values(SOURCE_SETTING_KEYS)) {
            await settings?.setBoolean(settingKey, false);
          }
          await settings?.setBoolean(SETTING_ENVIRONMENT_CONTEXT_ENABLED, false);
          await settings?.setBoolean(SETTING_KEYS.environmentProactiveEnabled, false);
          await settings?.setBoolean(SETTING_SCREEN_TEXT_ENABLED, false);
        } catch (caught) {
          error = `设置保存失败：${detailOf(caught)}`;
        }
      } finally {
        stopping = false;
        commit();
      }
    },

    dispose(): void {
      disposed = true;
      unsubscribeState?.();
      unsubscribeState = null;
      listeners.clear();
    },
  };

  return presenter;
}
