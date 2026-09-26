import type { AikaPlugin } from "../../kernel";
import { StorageToken } from "../../services/storage/tokens";
import { ClockToken, TimersToken } from "../../services/time/tokens";
import { NotifierToken } from "../../services/notification/notifier";
import { createLocalTasks, LocalTasksToken } from "../../services/runtime/localTasks";

export function localTasksPlugin(): AikaPlugin {
  return {
    id: "runtime.localTasks", version: "1.0.0",
    requires: [StorageToken, ClockToken, TimersToken, NotifierToken], provides: [LocalTasksToken],
    async activate(context) {
      const service = await createLocalTasks({ storage: context.registrar.resolve(StorageToken),
        clock: () => context.registrar.resolve(ClockToken).now(),
        timers: context.registrar.resolve(TimersToken), notifier: context.registrar.resolve(NotifierToken) });
      context.registrar.provide(LocalTasksToken, () => service);
      const stop = () => service.dispose();
      globalThis.addEventListener?.("pagehide", stop);
      context.onDispose(() => { globalThis.removeEventListener?.("pagehide", stop); stop(); });
    },
  };
}
