import { token } from "../../kernel";
import type { ProviderConfig } from "../../domain/providers";
import type { CompanionRuntime, RuntimeProvider } from "./companionRuntime";
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
