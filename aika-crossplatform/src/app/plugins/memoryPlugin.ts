import { KernelError, type AikaPlugin } from "../../kernel";
import { ContextSourcesToken } from "../../services/context/tokens";
import { createMemorySource } from "../../services/memory/memorySource";
import { createMemoryRepository } from "../../services/memory/memoryRepository";
import { MemoryAccessToken, MemoryRepositoryToken, type MemoryAccess } from "../../services/memory/tokens";
import { StorageToken } from "../../services/storage/tokens";
import { ClockToken } from "../../services/time/tokens";

/**
 * 记忆仓储与记忆上下文源。
 *
 * 这里有一个被内核逼出来的设计决定：`provides` 是**声明**，内核会核对它和实际
 * 注册是否一致，所以「有 memoryV2 就注册仓储、没有就不注册」这种运行时分支在
 * 一个插件里写不出来——少注册一个已声明的 token 会直接判该插件违约。
 *
 * 这是好事。它逼着把「这个宿主到底有没有记忆能力」变成**装配期的选择**，
 * 而不是藏在插件内部、谁也看不见的 if。所以拆成两个插件：装哪个由组合根决定。
 *
 * 记忆被删除时摘要整段作废：摘要没有可用的消息溯源，没法只摘掉其中一句。
 * 这条语义沿用 LLM-03，本插件只负责把它接上，不改策略。
 */
export function memoryPlugin(): AikaPlugin {
  return {
    id: "llm.memory",
    version: "1.0.0",
    requires: [StorageToken, ClockToken],
    provides: [MemoryRepositoryToken, MemoryAccessToken, ContextSourcesToken],
    activate(context) {
      const storage = context.registrar.resolve(StorageToken);
      const clock = context.registrar.resolve(ClockToken);
      const store = storage.memoryV2;

      if (!store) {
        // 两个生产存储实现都带 memoryV2；走到这里说明宿主装错了插件。
        // 与其悄悄降级成一个「能调但永远为空」的仓储，不如让装配失败得明明白白。
        throw new KernelError(
          "PLUGIN_CONTRACT_VIOLATION",
          `storage "${storage.kind}" has no memoryV2 port; install noMemoryPlugin() instead`,
          { storageKind: storage.kind },
        );
      }

      // 删除联动可能有多方关心（摘要落库 + 界面清显示）。仓储的 onInvalidate 只有一个
      // 回调位，所以由插件扇出；消费方订阅的是插件，不是各自再造一个仓储。
      const listeners = new Set<() => void>();
      // 「记忆变了」比「摘要作废」范围更大：确认与编辑不该让摘要失效，但同样要让
      // 另一个界面重读。两组订阅者分开，删除时两组都通知。
      const changedListeners = new Set<() => void>();

      function fanOut(targets: Set<() => void>): void {
        for (const listener of [...targets]) {
          try {
            listener();
          } catch {
            // 一个界面订阅者抛错不影响其它消费者，也不影响这次改动本身。
          }
        }
      }

      const repository = createMemoryRepository({
        store,
        clock: () => clock.now(),
        onInvalidate: async () => {
          await storage.deleteSummaries?.();
          fanOut(listeners);
          fanOut(changedListeners);
        },
      });
      const access: MemoryAccess = {
        repository,
        onInvalidate(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        onChanged(listener) {
          changedListeners.add(listener);
          return () => {
            changedListeners.delete(listener);
          };
        },
        notifyChanged() {
          fanOut(changedListeners);
        },
      };

      context.registrar.provide(MemoryRepositoryToken, () => repository);
      context.registrar.provide(MemoryAccessToken, () => access);
      context.registrar.provide(ContextSourcesToken, () => [createMemorySource(repository)]);
    },
  };
}

/**
 * 没有记忆能力的宿主用这个。
 *
 * 它只提供空的上下文来源，**不注册 MemoryRepositoryToken**——消费方按 optional
 * + tryResolve 拿到 null 就知道「这台机器上没有记忆」，而不是拿到一个假仓储。
 */
export function noMemoryPlugin(): AikaPlugin {
  return {
    id: "llm.memory",
    version: "1.0.0",
    provides: [ContextSourcesToken],
    activate(context) {
      context.registrar.provide(ContextSourcesToken, () => []);
    },
  };
}
