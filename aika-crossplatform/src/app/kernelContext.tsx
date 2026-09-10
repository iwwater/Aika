import { createContext, createElement, useContext, type ReactNode } from "react";
import { KernelError, type AikaKernel, type ServiceToken } from "../kernel";
import { resolvePresentationFallback, type PresentationServices } from "../presentation/fallback";

/**
 * React 侧唯一的取依赖入口。
 *
 * `resolve()` 只允许出现在三个地方：组合根、插件 activate、以及这里。业务组件与
 * Hook 通过 `useService` 拿依赖，不再 import 具体实现、也不再读平台嗅探结果。
 *
 * 装配失败时内核不可用，但 App 仍要能渲染（界面要显示存储故障），展示层服务由
 * 组合根经 `fallback` 显式传入；其余 token 仍如实抛错，不做静默降级。
 */

interface KernelContextValue {
  kernel: AikaKernel | null;
  presentation: PresentationServices | null;
}

const KernelContext = createContext<KernelContextValue>({ kernel: null, presentation: null });

export function KernelProvider(props: {
  kernel: AikaKernel | null;
  presentation?: PresentationServices | null;
  children: ReactNode;
}) {
  return createElement(
    KernelContext.Provider,
    { value: { kernel: props.kernel, presentation: props.presentation ?? null } },
    props.children,
  );
}

export function useService<T>(token: ServiceToken<T>): T {
  const { kernel, presentation } = useContext(KernelContext);
  if (kernel && kernel.state === "ready") return kernel.registry.resolve(token);

  const fallback = resolvePresentationFallback(presentation, token);
  if (fallback !== undefined) return fallback;

  if (!kernel) {
    throw new KernelError("KERNEL_NOT_READY", `useService(${token.key}) called outside KernelProvider`);
  }
  // 内核 failed/starting/disposed：交回注册表，让它按既有语义抛 KERNEL_FAILED 等。
  return kernel.registry.resolve(token);
}
