import { token } from "../../kernel";
import type { ProviderConfig } from "../../domain/providers";
import type { CompanionRuntime, RuntimeProvider } from "./companionRuntime";
import type { HostLifecycle } from "./hostLifecycle";
import type { ProviderSettings } from "./providerSettings";

/**
 * Runtime 相关的服务标识。
 *
 * 沿用 companionRuntime.ts 已有的 `CompanionRuntime` / `RuntimeProvider`，
 * 不重新造接口——LLM-02 已经把它们验收过了，这里只负责给它们配 token。
 */

export const RuntimeToken = token<CompanionRuntime>("llm.runtime");
export const ProviderToken = token<RuntimeProvider>("llm.provider");
export const ProviderSettingsToken = token<ProviderSettings>("llm.providerSettings");

/**
 * 消费方真正需要的一对：编排服务 + 本轮生效的 Provider 配置。
 *
 * CORE-06 之前它住在 `activeRuntime.ts` 的过渡槽里；现在由展示插件从注册表取出后
 * 注入 Presenter，`activeRuntimeServices()` 这个全局入口已删除。
 */
export interface RuntimeServices {
  runtime: CompanionRuntime;
  settings: ProviderSettings;
}

/**
 * Provider 连接自检。
 *
 * 设置页的「测试连接」不是对话编排，但同样属于 Provider 侧能力；做成端口后
 * `App.tsx` 不再直接 import providerClient，全仓 providerClient 的调用方只剩
 * Runtime 适配器与记忆抽取。
 */
export type ProviderProbe = (config: ProviderConfig) => Promise<string>;

export const ProviderProbeToken = token<ProviderProbe>("llm.providerProbe");

/**
 * 设置页「获取模型列表」。
 *
 * 与 ProviderProbe 同理：拉取平台可用模型列表是 Provider 侧能力，做成端口后
 * App 不直接 import providerClient。返回按字典序排好的模型 ID。
 */
export type ProviderModels = (config: ProviderConfig) => Promise<string[]>;

export const ProviderModelsToken = token<ProviderModels>("llm.providerModels");

/**
 * 宿主存活状态（RT-01-D）。
 *
 * 它不只在桌面有用：浏览器 dev 同样是「本进程还活着吗」这个问题的实例，
 * 所以由宿主装配层（`app/hosts`）而非某个平台专属插件提供。远端出站用它的
 * `epoch()` 作为 `gatewayEpoch`——宿主重启必然换 epoch，客户端据此重同步。
 */
export const HostLifecycleToken = token<HostLifecycle>("host.lifecycle");
