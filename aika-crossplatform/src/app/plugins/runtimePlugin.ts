import type { AikaPlugin } from "../../kernel";
import { ContextSourcesToken } from "../../services/context/tokens";
import { createCompanionRuntime, type TurnTrace } from "../../services/runtime/companionRuntime";
import { createStreamChatProvider, providerModels, providerProbe } from "../../services/runtime/providerAdapter";
import {
  ProviderModelsToken, ProviderProbeToken, ProviderSettingsToken, ProviderToken, RuntimeToken,
} from "../../services/runtime/tokens";
import { StorageToken } from "../../services/storage/tokens";
import { TraceRecorderToken } from "../../services/trace/tokens";
import { NO_TRACE } from "../../services/trace/traceRecorder";
import { UsageLedgerToken } from "../../services/usage/tokens";
import { ClockToken, TimersToken } from "../../services/time/tokens";

/**
 * 把 CompanionRuntime 接上电。
 *
 * 在此之前它是一段**没有任何生产调用方**的代码：LLM-02 把它写完并验收了，但
 * 应用真正跑的一直是 useCompanionSession 里那三百多行 send()。两条编排各写各的
 * 打断、迟到结果与落库，其中只有一条有独立于 React 的测试保护。
 *
 * 这个插件负责让 Runtime 成为注册表里唯一的编排服务；把 Hook 切过来是
 * CORE-03 的第二步，由 core.orchestrator 开关控制，可回滚。
 */

export interface RuntimePluginOptions {
  /** 读进上下文的最近消息条数上限。 */
  historyLimit?: number;
  /** 语音交付等待上限：无进度到此就失败，不无限占着 busy。 */
  deliveryTimeoutMs?: number;
  /** 降级 trace 只进日志与报告，不进正文。 */
  onTrace?: (trace: TurnTrace) => void;
}

export function runtimePlugin(options: RuntimePluginOptions = {}): AikaPlugin {
  return {
    id: "llm.runtime",
    version: "1.0.0",
    requires: [StorageToken, ClockToken, TimersToken, ProviderSettingsToken, ContextSourcesToken],
    // Trace 与用量台账都是可选能力：没装时 tryResolve 拿到 null，分别退回
    // NO_TRACE 与「不记账」。「能力缺失即 token 不注册」，不需要运行时开关分支。
    optional: [TraceRecorderToken, UsageLedgerToken],
    provides: [ProviderToken, RuntimeToken, ProviderProbeToken, ProviderModelsToken],
    activate(context) {
      const storage = context.registrar.resolve(StorageToken);
      const clock = context.registrar.resolve(ClockToken);
      const timers = context.registrar.resolve(TimersToken);
      const settings = context.registrar.resolve(ProviderSettingsToken);
      const sources = context.registrar.resolve(ContextSourcesToken);
      const trace = context.registrar.tryResolve(TraceRecorderToken) ?? NO_TRACE;
      const usageRecorder = context.registrar.tryResolve(UsageLedgerToken) ?? undefined;

      const provider = createStreamChatProvider({
        getConfig: () => settings.get(),
        getStickers: () => settings.getStickers(),
        trace,
        ...(usageRecorder ? { usageRecorder } : {}),
      });

      const runtime = createCompanionRuntime({
        provider,
        storage,
        sources,
        clock,
        timers,
        historyLimit: options.historyLimit,
        deliveryTimeoutMs: options.deliveryTimeoutMs,
        onTrace: options.onTrace,
        trace,
      });

      context.registrar.provide(ProviderToken, () => provider);
      // 设置页的连接自检与模型列表走端口，App 不再直接 import providerClient。
      context.registrar.provide(ProviderProbeToken, () => providerProbe);
      context.registrar.provide(ProviderModelsToken, () => providerModels);
      context.registrar.provide(RuntimeToken, () => runtime, {
        // 内核 dispose 时把在途轮次收干净：不 dispose 的话取消不掉的生成会继续烧 token。
        disposer: (value) => value.dispose(),
      });
    },
  };
}
