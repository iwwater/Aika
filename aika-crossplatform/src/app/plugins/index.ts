import type { AikaPlugin } from "../../kernel";
import { PROVIDER_PRESETS, type ProviderConfig } from "../../domain/providers";
import { createProviderSettings } from "../../services/runtime/providerSettings";
import { ProviderSettingsToken } from "../../services/runtime/tokens";
import { memoryPlugin } from "./memoryPlugin";
import { runtimePlugin, type RuntimePluginOptions } from "./runtimePlugin";

export { memoryPlugin, noMemoryPlugin } from "./memoryPlugin";
export { runtimePlugin, type RuntimePluginOptions } from "./runtimePlugin";

/**
 * 当前 Provider 配置与表情包清单。
 *
 * 初始值是预设；真正生效的配置由设置界面在启动后写进来。做成服务而不是让
 * Runtime 去读 Hook 的 ref，是因为 Runtime 不该认识 React。
 */
export function providerSettingsPlugin(
  initial: ProviderConfig = PROVIDER_PRESETS[1],
): AikaPlugin {
  return {
    id: "llm.providerSettings",
    version: "1.0.0",
    provides: [ProviderSettingsToken],
    activate(context) {
      const settings = createProviderSettings(initial);
      context.registrar.provide(ProviderSettingsToken, () => settings);
    },
  };
}

/**
 * LLM 侧的默认能力插件。
 *
 * CORE-03 第一步只是让它们能被装配起来；把 Hook 切到 Runtime 由
 * core.orchestrator 开关控制，是第二步的事。
 */
export function llmPlugins(options: RuntimePluginOptions = {}): AikaPlugin[] {
  return [providerSettingsPlugin(), memoryPlugin(), runtimePlugin(options)];
}
