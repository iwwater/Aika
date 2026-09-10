import type { ServiceToken } from "../kernel";
import type { CompanionPresenter } from "./companionPresenter";
import type { VoicePresenter } from "./voicePresenter";
import { CompanionPresenterToken, VoicePresenterToken } from "./tokens";

/**
 * 装配失败时的展示层兜底。
 *
 * 正常情况下 Presenter 由注册表提供、Hook 经 `useService` 取用。但「内核启动失败
 * 也要能渲染、界面要显示存储故障」是既有约定；这时注册表不可用，组合根把同一批
 * Presenter 交给 `KernelProvider`，`useService` 依次降级。
 *
 * 这里刻意不做模块级全局槽：兜底是组合根传给 React 的显式值，避免测试之间互相污染。
 */
export interface PresentationServices {
  companion: CompanionPresenter;
  voice: VoicePresenter;
}

/** 只认展示层自己的 token，其余一律交回注册表。 */
export function resolvePresentationFallback<T>(
  services: PresentationServices | null | undefined,
  token: ServiceToken<T>,
): T | undefined {
  if (!services) return undefined;
  if (token === CompanionPresenterToken) return services.companion as unknown as T;
  if (token === VoicePresenterToken) return services.voice as unknown as T;
  return undefined;
}
