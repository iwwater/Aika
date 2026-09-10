/**
 * 内核对外入口。
 *
 * 这里导出的全是通用装配设施，没有一个业务概念，也没有一个 token 实例。
 * 业务 token 由各自模块定义在它们的接口旁边，不在这里汇总——有中央清单，
 * 「新增一种能力」就等于「改内核」。
 */

export { token, describeToken, type ServiceToken } from "./token";
export { KernelError, isKernelError, type KernelErrorCode } from "./errors";
export {
  createRegistry,
  type InternalRegistry, type RegisterOptions, type RegistryEntrySnapshot,
  type ResolveContext, type ServiceRegistry,
} from "./registry";
export { createEventBus, type KernelEvent, type KernelEventSource } from "./eventBus";
export {
  createNoopLogger, planActivation,
  type AikaPlugin, type KernelLogger, type PluginContext, type PluginRegistrar,
} from "./plugin";
export {
  type KernelSnapshot, type KernelStartReport, type KernelState,
  type PluginRecord, type PluginStatus,
} from "./diagnostics";
export { createKernel, type AikaKernel, type KernelOptions } from "./kernel";
