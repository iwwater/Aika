import type { AikaPlugin } from "../../kernel";
import { createNoopNotifier } from "../../services/notification/notifier";
import { NotifierToken } from "../../services/notification/notifier";
import { MemoryAccessToken } from "../../services/memory/tokens";
import { ProviderSettingsToken, RuntimeToken, type RuntimeServices } from "../../services/runtime/tokens";
import { StorageToken } from "../../services/storage/tokens";
import { StickerLibraryToken } from "../../services/stickers/tokens";
import { SpeechEnginesToken } from "../../services/voice/tokens";
import { SecretStoreToken } from "../../services/storage/tokens";
import { createVoiceOutputSettings } from "../../services/voice/outputSettings";
import type { VoiceOutputConfig } from "../../services/voice/outputEngine";
import { TraceRecorderToken, TraceSettingsToken, TraceSinkToken } from "../../services/trace/tokens";
import { createCompanionPresenter } from "../../presentation/companionPresenter";
import { createVoicePresenter } from "../../presentation/voicePresenter";
import { createDevToolsPresenter } from "../../presentation/devToolsPresenter";
import { createMemoryPresenter } from "../../presentation/memoryPresenter";
import { createStoragePresenter } from "../../presentation/storagePresenter";
import { createInspectorPresenter } from "../../presentation/inspectorPresenter";
import { createOpsPresenter } from "../../presentation/opsPresenter";
import { UsageLedgerStoreToken, UsageLedgerToken } from "../../services/usage/tokens";
import {
  CompanionPresenterToken, DevToolsPresenterToken, MemoryPresenterToken,
  StoragePresenterToken, VoicePresenterToken, InspectorPresenterToken, OpsPresenterToken,
} from "../../presentation/tokens";

/**
 * 展示层插件。
 *
 * Presenter 是注册表里的普通服务；Hook 用 `useService(CompanionPresenterToken)` 取。
 * 依赖经构造参数注入——Presenter 不认识注册表，也不认识 `activeRuntimeServices`
 * 之类的过渡槽（CORE-06 已删除）。
 *
 * 两个刻意的设计：
 *
 * 1. **Presenter 惰性构造**。`provide` 的工厂在第一次 resolve 时才跑，因此没人取
 *    展示层时不会顺带实例化 Runtime——CORE-01 的「没人 resolve 就不构造」这条不能被
 *    展示层破坏。
 * 2. **能力全部 optional**。宿主没有存储、没有记忆、没有表情包、没有语音引擎时各自
 *    降级，而不是激活失败；运行时缺失时 Presenter 不发请求，也不退回第二套编排。
 *
 * 它不声明硬依赖：内核启动失败时本插件不会激活，组合根直接构造兜底实例交给
 * KernelProvider，界面仍能显示故障。
 */
export interface PresentationPluginOptions {
  /**
   * 惰性取运行时服务。运行时要等真正发一轮时才实例化，所以这里必须是闭包而不是
   * 现成对象；组合根用注册表视图实现它。
   */
  resolveRuntime?: () => RuntimeServices | null;
}

export function presentationPlugin(options: PresentationPluginOptions = {}): AikaPlugin {
  return {
    id: "presentation.core",
    version: "1.0.0",
    optional: [
      StorageToken, NotifierToken, SecretStoreToken,
      RuntimeToken, ProviderSettingsToken,
      MemoryAccessToken, StickerLibraryToken, SpeechEnginesToken,
      TraceRecorderToken, TraceSinkToken, TraceSettingsToken,
      UsageLedgerToken, UsageLedgerStoreToken,
    ],
    provides: [
      CompanionPresenterToken, VoicePresenterToken, DevToolsPresenterToken,
      MemoryPresenterToken, StoragePresenterToken, InspectorPresenterToken, OpsPresenterToken,
    ],
    activate(context) {
      const storage = context.registrar.tryResolve(StorageToken);
      const notifier = context.registrar.tryResolve(NotifierToken);
      const memoryAccess = context.registrar.tryResolve(MemoryAccessToken);
      const stickers = context.registrar.tryResolve(StickerLibraryToken);
      const engines = context.registrar.tryResolve(SpeechEnginesToken);
      const secrets = context.registrar.tryResolve(SecretStoreToken);
      // TTS-04 桥接：companionPresenter 保存配置后推给 voicePresenter 重建输出。
      // voicePresenter 可能还没构造（惰性），所以最后一份配置先留在闭包里，
      // 构造时作为初始配置应用——重启后持久化配置不会被默认 system 覆盖。
      let lastVoiceOutput: VoiceOutputConfig | null = null;
      let voicePresenterRef: { applyVoiceOutput(config: VoiceOutputConfig): void } | null = null;
      const trace = context.registrar.tryResolve(TraceRecorderToken);
      const traceSink = context.registrar.tryResolve(TraceSinkToken);
      const traceSettings = context.registrar.tryResolve(TraceSettingsToken);
      const usageRecorder = context.registrar.tryResolve(UsageLedgerToken);

      context.registrar.provide(VoicePresenterToken, () => {
        const presenter = createVoicePresenter({
          ...(engines
            ? {
                createInputEngine: (config) => engines.createInputEngine(config),
                outputEngine: engines.outputEngine,
                resolveOutput: engines.resolveOutput,
                createQueue: engines.createQueue,
                createMonitor: engines.createMonitor,
              }
            : {}),
          ...(lastVoiceOutput ? { initialOutputConfig: lastVoiceOutput } : {}),
          ...(trace ? { trace } : {}),
        });
        voicePresenterRef = presenter;
        return presenter;
      }, { disposer: (value) => value.dispose() });

      context.registrar.provide(CompanionPresenterToken, () => createCompanionPresenter({
        loadStorage: storage
          ? async () => storage
          : async () => { throw new Error("本地存储尚未装配，对话与记忆无法读写"); },
        notifier: notifier ?? createNoopNotifier(),
        runtime: options.resolveRuntime?.() ?? null,
        ...(memoryAccess ? { memoryAccess } : {}),
        ...(stickers ? { loadStickers: stickers } : {}),
        ...(trace ? { trace } : {}),
        ...(usageRecorder ? { usageRecorder } : {}),
        ...(storage && secrets
          ? { voiceOutputSettings: createVoiceOutputSettings({ storage, secrets }) }
          : {}),
        applyVoiceOutput: (config: VoiceOutputConfig) => {
          lastVoiceOutput = config;
          voicePresenterRef?.applyVoiceOutput(config);
        },
      }), { disposer: (value) => value.dispose() });

      // 工作台 Presenter 总是注册：没装 Trace 时它负责显示「未启用」，
      // 而不是让入口凭空消失（那会被读成「这个功能不存在」）。
      context.registrar.provide(DevToolsPresenterToken, () => createDevToolsPresenter({
        sink: traceSink ?? null,
        settings: traceSettings ?? null,
        loadStorage: storage
          ? async () => storage
          : async () => { throw new Error("本地存储尚未装配，开发者设置无法保存"); },
      }), { disposer: (value) => value.dispose() });

      // 记忆管理 Presenter 同样总是注册：没装记忆能力时它负责说清楚这件事。
      context.registrar.provide(MemoryPresenterToken, () => createMemoryPresenter({
        access: memoryAccess ?? null,
      }), { disposer: (value) => value.dispose() });

      // Live Inspector（FE-23）：sink/settings 缺任一就显示引导，不崩、不自行开启。
      context.registrar.provide(InspectorPresenterToken, () => createInspectorPresenter({
        sink: traceSink,
        settings: traceSettings,
      }));

      // 存储浏览：SQL 执行器是存储的可选成员，localStorage 实现没有——
      // 那时页面负责说清楚，而不是显示一个空库。
      context.registrar.provide(StoragePresenterToken, () => createStoragePresenter({
        executor: storage?.sqlExecutor ?? null,
      }), { disposer: (value) => value.dispose() });

      // Ops 成本页（FE-26）：台账 store 是可选能力，没装 usagePlugin 时页面
      // 显示「没有采集」，入口照常存在。
      const usageStore = context.registrar.tryResolve(UsageLedgerStoreToken);
      context.registrar.provide(OpsPresenterToken, () => createOpsPresenter({
        store: usageStore ?? null,
        loadStorage: storage
          ? async () => storage
          : async () => { throw new Error("本地存储尚未装配，价目无法保存"); },
        ...(traceSettings ? { isCaptureEnabled: () => traceSettings.get().enabled } : {}),
      }), { disposer: (value) => value.dispose() });
    },
  };
}
