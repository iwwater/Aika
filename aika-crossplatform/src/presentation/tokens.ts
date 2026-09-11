import { token } from "../kernel";
import type { CompanionPresenter } from "./companionPresenter";
import type { VoicePresenter } from "./voicePresenter";
import type { DevToolsPresenter } from "./devToolsPresenter";

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
/**
 * 工作台 Presenter（FE-09）。
 *
 * 它**总是**注册，即使没装 Trace 能力——页面要能显示「Trace 未启用」，
 * 而不是连入口都消失让用户以为功能不存在。缺失的是 sink，不是这个 Presenter。
 */
export const DevToolsPresenterToken = token<DevToolsPresenter>("presentation.devtools");
