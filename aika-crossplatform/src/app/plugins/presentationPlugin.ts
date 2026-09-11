import type { AikaPlugin } from "../../kernel";
import { createNoopNotifier } from "../../services/notification/notifier";
import { NotifierToken } from "../../services/notification/notifier";
import { MemoryAccessToken } from "../../services/memory/tokens";
import { ProviderSettingsToken, RuntimeToken, type RuntimeServices } from "../../services/runtime/tokens";
import { StorageToken } from "../../services/storage/tokens";
import { StickerLibraryToken } from "../../services/stickers/tokens";
import { SpeechEnginesToken } from "../../services/voice/tokens";
import { TraceRecorderToken } from "../../services/trace/tokens";
import { createCompanionPresenter } from "../../presentation/companionPresenter";
import { createVoicePresenter } from "../../presentation/voicePresenter";
import { CompanionPresenterToken, VoicePresenterToken } from "../../presentation/tokens";

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
      StorageToken, NotifierToken,
      RuntimeToken, ProviderSettingsToken,
      MemoryAccessToken, StickerLibraryToken, SpeechEnginesToken,
      TraceRecorderToken,
    ],
    provides: [CompanionPresenterToken, VoicePresenterToken],
    activate(context) {
      const storage = context.registrar.tryResolve(StorageToken);
      const notifier = context.registrar.tryResolve(NotifierToken);
      const memoryAccess = context.registrar.tryResolve(MemoryAccessToken);
      const stickers = context.registrar.tryResolve(StickerLibraryToken);
      const engines = context.registrar.tryResolve(SpeechEnginesToken);
      const trace = context.registrar.tryResolve(TraceRecorderToken);

      context.registrar.provide(VoicePresenterToken, () => createVoicePresenter({
        ...(engines
          ? {
              createInputEngine: (config) => engines.createInputEngine(config),
              outputEngine: engines.outputEngine,
              createQueue: engines.createQueue,
              createMonitor: engines.createMonitor,
            }
          : {}),
        ...(trace ? { trace } : {}),
      }), { disposer: (value) => value.dispose() });

      context.registrar.provide(CompanionPresenterToken, () => createCompanionPresenter({
        loadStorage: storage
          ? async () => storage
          : async () => { throw new Error("本地存储尚未装配，对话与记忆无法读写"); },
        notifier: notifier ?? createNoopNotifier(),
        runtime: options.resolveRuntime?.() ?? null,
        ...(memoryAccess ? { memoryAccess } : {}),
        ...(stickers ? { loadStickers: stickers } : {}),
        ...(trace ? { trace } : {}),
      }), { disposer: (value) => value.dispose() });
    },
  };
}
