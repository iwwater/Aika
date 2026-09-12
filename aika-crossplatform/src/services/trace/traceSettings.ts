/**
 * Trace 的两个开关。
 *
 * 做成可变服务而不是启动时定值，是为了让设置页一改就生效——recorder 每次记录都
 * 重新读一次，不需要重建任何东西（与 providerSettings 同一套路）。
 */

export interface TraceSettings {
  /** 关掉时一个事件都不产生，连事件对象都不构造。 */
  enabled: boolean;
  /** 正文（用户原话、instructions 摘要）要不要进盘。默认不进。 */
  includeText: boolean;
}

export interface TraceSettingsService {
  get(): TraceSettings;
  set(next: Partial<TraceSettings>): void;
  /** 设置变化订阅（FE-23）：返回退订函数。监听器异常与主链路相互隔离。 */
  onChanged(listener: (next: TraceSettings) => void): () => void;
}

/**
 * 默认值按构建取：开发构建常开，生产默认关（规划文档 §7 问题 2 的建议——
 * 崩溃时再引导用户临时打开，而不是默认给所有人留一份对话记录）。
 *
 * 读不到构建标记时按**关**处理：默认不留痕比默认留痕安全。
 */
export function defaultTraceSettings(): TraceSettings {
  let dev = false;
  try {
    dev = Boolean((import.meta as { env?: { DEV?: boolean } }).env?.DEV);
  } catch {
    dev = false;
  }
  // includeText 与构建无关：正文进不进盘永远是用户的选择，默认不进。
  return { enabled: dev, includeText: false };
}

export function createTraceSettings(initial: TraceSettings = defaultTraceSettings()): TraceSettingsService {
  let current: TraceSettings = { ...initial };
  const listeners = new Set<(next: TraceSettings) => void>();
  return {
    get: () => current,
    set(next) {
      current = { ...current, ...next };
      for (const listener of [...listeners]) {
        try {
          listener(current);
        } catch {
          // 设置变化的监听器抛错不影响主链路，也不影响其它监听器。
        }
      }
    },
    onChanged(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
