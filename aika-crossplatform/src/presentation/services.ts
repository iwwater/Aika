import { createCompanionPresenter, type CompanionPresenterDeps } from "./companionPresenter";
import { createVoicePresenter, type VoicePresenterDeps } from "./voicePresenter";
import type { PresentationServices } from "./fallback";

/**
 * 一次性构造展示层两个服务。
 *
 * CORE-06 之后这主要用于**装配失败时的兜底**：展示插件自己惰性构造 Presenter
 * （这样没人解析时不会顺带实例化 Runtime），而组合根在启动失败、注册表不可用时
 * 需要一个已经可用的实例交给 KernelProvider。
 */
export interface PresentationServiceDeps {
  /** 会话 Presenter 的依赖；兜底路径由组合根注入必定失败的 loadStorage。 */
  companion: CompanionPresenterDeps;
  voice?: VoicePresenterDeps;
}

export function createPresentationServices(deps: PresentationServiceDeps): PresentationServices {
  return {
    companion: createCompanionPresenter(deps.companion),
    voice: createVoicePresenter(deps.voice),
  };
}
