import type { CompanionRuntime } from "./companionRuntime";
import type { ProviderSettings } from "./providerSettings";

/**
 * 迁移期开关与运行时服务的过渡入口。
 *
 * `useCompanionSession` 还没接注册表（那是 CORE-04），但 CORE-03 要让它能走
 * Runtime。所以由组合根在启动时把服务装进来，Hook 通过这里取。
 *
 * 开关只读一次、不支持运行中热切换：中途切换会让在途轮次归属不清——旧路径的
 * 私有计数和 Runtime 的 revision 各判各的，谁都不知道那一轮算谁的。
 *
 * CORE-06 删除本文件与全部调用方。
 */

export type OrchestratorMode = "legacy" | "kernel";

/** 迁移期默认值。只有 CORE-03 的 AC 全部 PASS 之后才翻成 kernel。 */
export const DEFAULT_ORCHESTRATOR: OrchestratorMode = "legacy";

export function normalizeOrchestrator(raw: string | null | undefined): OrchestratorMode {
  return raw === "kernel" ? "kernel" : DEFAULT_ORCHESTRATOR;
}

export interface RuntimeServices {
  runtime: CompanionRuntime;
  settings: ProviderSettings;
}

let installed: RuntimeServices | null = null;

/** 组合根在 orchestrator 为 kernel 且 Runtime 装配成功时调用。 */
export function installRuntimeServices(services: RuntimeServices): void {
  installed = services;
}

/** 测试用：恢复到未安装状态。 */
export function resetInstalledRuntimeServices(): void {
  installed = null;
}

/**
 * 拿到运行时服务；返回 null 表示这次运行走旧编排。
 *
 * 返回 null 的原因可能是开关是 legacy，也可能是 Runtime 没装配成功——
 * 两种情况下旧路径都还能用，这正是开关存在的意义。
 */
export function activeRuntimeServices(): RuntimeServices | null {
  return installed;
}
