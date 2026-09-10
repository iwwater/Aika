import { token } from "../kernel";
import type { CompanionPresenter } from "./companionPresenter";
import type { VoicePresenter } from "./voicePresenter";

/**
 * 展示层服务标识。
 *
 * Presenter 与 Runtime、Storage 一样是注册表里的普通服务：由组合根装配、由插件
 * 提供、由 Hook 经 `useService` 取用。token 定义在它描述的接口旁边，不做中央清单。
 *
 * ProviderSettings 里那句「CORE-04 之后由 Presenter 持有它，Hook 不再直接碰」
 * 指的就是这里：Hook 只拿这一个 token，不再认识 activeRuntimeServices 之类的过渡槽。
 */
export const CompanionPresenterToken = token<CompanionPresenter>("presentation.companion");
export const VoicePresenterToken = token<VoicePresenter>("presentation.voice");
