import type { AikaPlugin } from "../../kernel";
import { PROVIDER_PRESETS, type ProviderConfig } from "../../domain/providers";
import { createProviderSettings } from "../../services/runtime/providerSettings";
import { ProviderSettingsToken } from "../../services/runtime/tokens";
import { contextSourcesPlugin } from "./contextSourcesPlugin";
import { memoryPlugin } from "./memoryPlugin";
import { runtimePlugin, type RuntimePluginOptions } from "./runtimePlugin";
import { stickersPlugin } from "./stickersPlugin";
import { tracePlugin } from "./tracePlugin";
import { usagePlugin } from "./usagePlugin";
import { voicePlugin } from "./voicePlugin";
import { outboundPlugin } from "../../services/outbound/outboundPlugin";
import { LOCAL_PRINCIPAL_ID } from "../../domain/identity";
import { localTasksPlugin } from "./localTasksPlugin";

export { memoryPlugin, noMemoryPlugin } from "./memoryPlugin";
export { contextSourcesPlugin } from "./contextSourcesPlugin";
export { runtimePlugin, type RuntimePluginOptions } from "./runtimePlugin";
export { presentationPlugin } from "./presentationPlugin";
export { stickersPlugin } from "./stickersPlugin";
export { tracePlugin, type TracePluginOptions } from "./tracePlugin";
export { usagePlugin, type UsagePluginOptions } from "./usagePlugin";
export { voicePlugin, defaultSpeechEngines } from "./voicePlugin";
export { outboundPlugin, type OutboundPluginOptions } from "../../services/outbound/outboundPlugin";
export { sampleCapabilityPlugin, SampleCapabilityToken, type SampleCapability } from "./sampleCapabilityPlugin";

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
  return [providerSettingsPlugin(), memoryPlugin(), contextSourcesPlugin(), runtimePlugin(options)];
}

/**
 * 应用默认装配的能力插件。
 *
 * CORE-05 的结论要能成立，这些插件必须真的被装上——只写不装就是死代码。语音与
 * 表情包没有硬依赖，因此浏览器宿主也装得起；记忆与 Runtime 的宿主前置由宿主插件
 * 保证（两个生产存储实现都带 memoryV2）。
 */
export function capabilityPlugins(options: RuntimePluginOptions = {}, withWiki = true): AikaPlugin[] {
  return [
    providerSettingsPlugin(),
    memoryPlugin(),
    contextSourcesPlugin(withWiki),
    // Trace 排在 runtime 之前只是可读性：真正的顺序由内核按 requires/optional 解析。
    tracePlugin(),
    // 用量台账跟在 trace 后面：它的采集开关读 TraceSettings（LLM-12 契约）。
    usagePlugin(),
    localTasksPlugin(),
    runtimePlugin(options),
    // 远程出站：requires Runtime；transport/生命周期都从注册表 tryResolve，
    // 浏览器宿主没有传输即自动退化为「本地投影，不外发」（FE-17-host）。
    // 命令授权：Rust 宿主已完成 token 认证与会话准入，这里核验主体是
    // 服务端注入的本地主体（principal 不经 body，伪造在 handleCommand 前就被拒）
    // ——没有这道核验就等于不接命令（fail-closed，outboundPlugin 的缺省）。
    outboundPlugin({
      commandAuthorizer: (input) => input.principal.principalId === LOCAL_PRINCIPAL_ID,
    }),
    voicePlugin(),
    stickersPlugin(),
  ];
}
