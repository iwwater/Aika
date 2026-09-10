/**
 * 内核事件。
 *
 * 这条流只发内核自身的生命周期事实，是**封闭联合**，且不含一个业务词。
 * 插件只能订阅、不能 publish——一旦允许 publish，它迟早会变成「什么都往里塞」
 * 的应用消息总线，而对话 turn 的顺序与幂等保证只能由 CompanionRuntime 的
 * RuntimeEvent 负责，两套事件混用会把那份保证毁掉。
 */

export type KernelEvent =
  | { type: "plugin.activated"; pluginId: string; durationMs: number }
  | { type: "plugin.failed"; pluginId: string; code: string; message: string }
  | { type: "plugin.rolledBack"; pluginId: string }
  | { type: "service.registered"; key: string; pluginId: string }
  | { type: "kernel.ready"; durationMs: number }
  | { type: "kernel.failed"; code: string }
  | { type: "kernel.disposed" };

/** 对插件与外部只暴露订阅。 */
export interface KernelEventSource {
  subscribe(listener: (event: KernelEvent) => void): () => void;
}

export interface InternalEventBus extends KernelEventSource {
  publish(event: KernelEvent): void;
}

export interface EventBusOptions {
  /** 订阅者自己抛的错。默认吞掉——一个坏订阅者不该拖垮内核启动。 */
  onListenerError?: (error: unknown, event: KernelEvent) => void;
}

export function createEventBus(options: EventBusOptions = {}): InternalEventBus {
  const listeners = new Set<(event: KernelEvent) => void>();

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    publish(event) {
      // 先快照：订阅者在回调里退订不该影响本次派发的名单。
      for (const listener of [...listeners]) {
        try {
          listener(event);
        } catch (error) {
          options.onListenerError?.(error, event);
        }
      }
    },
  };
}
