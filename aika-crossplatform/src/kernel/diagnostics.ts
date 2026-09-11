import type { RegistryEntrySnapshot } from "./registry";

/**
 * 诊断输出。
 *
 * 一条硬要求：`describe()` 在**任何状态下都必须可用**，尤其是 failed。
 * 启动失败正是最需要知道「排到哪、谁炸的、什么码」的时候，这时候诊断
 * 用不了等于没有诊断。
 */

export type KernelState =
  | "created"
  | "starting"
  | "ready"
  | "failed"
  | "disposing"
  | "disposed";

export type PluginStatus =
  /** 已登记，还没轮到它。 */
  | "pending"
  /** activate 成功且声明与事实一致。 */
  | "activated"
  /** 它自己炸了。 */
  | "failed"
  /** 它没问题，是被别人的失败连累回滚的。 */
  | "rolledBack"
  /** 预检阶段就整体失败了，压根没开始激活。 */
  | "skipped";

export interface PluginRecord {
  id: string;
  version: string;
  status: PluginStatus;
  error?: { code: string; message: string };
  /**
   * 三份声明，以 token key 的形式带出来（CORE-09）。
   *
   * 只给 key 字符串，不给 token 实例——拿到实例就等于能绕过注册表直接 resolve，
   * 那是 CORE-01 明确堵住的路。
   *
   * 在**登记**时记录而不是激活后：`pending` / `failed` / `skipped` 的插件也要能
   * 出现在拓扑图里，「谁没装上」恰恰是最需要看见的。
   */
  requires: readonly string[];
  optional: readonly string[];
  provides: readonly string[];
}

export interface KernelSnapshot {
  state: KernelState;
  plugins: readonly PluginRecord[];
  services: readonly RegistryEntrySnapshot[];
}

export interface StartFailure {
  pluginId: string;
  code: string;
  message: string;
}

export interface KernelStartReport {
  ok: boolean;
  state: "ready" | "failed";
  activated: readonly string[];
  /** 激活失败的插件；ok 为 false 时至少一条。 */
  failed: readonly StartFailure[];
  /** 回滚期间 deactivate 自己抛的错。与上面分开：这是「收拾现场时又摔了一跤」。 */
  rollbackErrors: readonly { pluginId: string; message: string }[];
  durationMs: number;
}

export function buildSnapshot(
  state: KernelState,
  plugins: readonly PluginRecord[],
  services: readonly RegistryEntrySnapshot[],
): KernelSnapshot {
  return {
    state,
    plugins: plugins.map((record) => ({ ...record })),
    services: services.map((entry) => ({ ...entry })),
  };
}
