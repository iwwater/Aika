import {
  buildSnapshot, type KernelSnapshot, type KernelStartReport, type KernelState,
  type PluginRecord, type StartFailure,
} from "./diagnostics";
import { codeOf, KernelError, messageOf } from "./errors";
import { createEventBus, type KernelEventSource } from "./eventBus";
import {
  createNoopLogger, createScopedRegistrar, planActivation,
  type AikaPlugin, type KernelLogger, type PluginContext,
} from "./plugin";
import { createRegistry, type ServiceRegistry } from "./registry";

/**
 * 内核。
 *
 * 它只认识四样东西：token、factory、plugin、生命周期。它不知道这个产品有哪些
 * 业务能力——不认识 runtime、memory、voice、storage、remote 是什么，也不定义
 * 任何 token 实例。判据很简单：这个目录能整包搬去别的项目而不带一句本产品语义。
 *
 * 启动只有两种结局，没有第三种：
 * - ready：全部插件按拓扑顺序激活，且各自「说的」和「做的」一致。
 * - failed：任何一步出问题，已激活的按逆序拆干净，不留半启动状态。
 *
 * failed 之后不允许原地重试——带着上一次的残留再跑一遍，出的问题没人能复现。
 * 要重试就新建一个内核实例。
 */

export type { KernelState, KernelSnapshot, KernelStartReport } from "./diagnostics";

export interface AikaKernel {
  /** 只读视图：写入的唯一入口是插件的作用域注册器。 */
  readonly registry: ServiceRegistry;
  /** 只能订阅。 */
  readonly events: KernelEventSource;
  readonly state: KernelState;
  /** 只能在 created 阶段调用。 */
  use(plugin: AikaPlugin): AikaKernel;
  start(): Promise<KernelStartReport>;
  dispose(): Promise<void>;
  /** 任何状态下都可用。 */
  describe(): KernelSnapshot;
}

export interface KernelOptions {
  logger?: KernelLogger;
  /** 注入时钟，让 durationMs 在测试里可预期。 */
  now?: () => number;
}

interface ActivatedEntry {
  plugin: AikaPlugin;
  /** 该插件在 activate 期间登记的清理函数，拆的时候逆序执行。 */
  cleanups: (() => void | Promise<void>)[];
}

export function createKernel(options: KernelOptions = {}): AikaKernel {
  const logger = options.logger ?? createNoopLogger();
  const now = options.now ?? (() => Date.now());
  const registry = createRegistry();
  const events = createEventBus({
    onListenerError: (error) => {
      // 一个坏订阅者不该拖垮启动，但也不能悄无声息。
      logger.error("kernel event listener threw", { message: messageOf(error) });
    },
  });

  const plugins: AikaPlugin[] = [];
  const records = new Map<string, PluginRecord>();
  const activated: ActivatedEntry[] = [];

  let state: KernelState = "created";
  let disposing: Promise<void> | null = null;

  function stateGate(): KernelError | null {
    if (state === "ready") return null;
    if (state === "failed") {
      return new KernelError("KERNEL_FAILED", "kernel failed to start; services are not available");
    }
    if (state === "disposing" || state === "disposed") {
      return new KernelError("KERNEL_INVALID_STATE", `kernel is ${state}`);
    }
    return new KernelError("KERNEL_NOT_READY", `kernel is ${state}; call start() first`);
  }

  const view = registry.createView(stateGate);

  function record(id: string): PluginRecord {
    return records.get(id) as PluginRecord;
  }

  function assertUsable(action: string): void {
    if (state === "created") return;
    if (state === "failed") {
      throw new KernelError(
        "KERNEL_FAILED",
        `cannot ${action}: kernel already failed; create a new kernel instead of retrying in place`,
      );
    }
    throw new KernelError("KERNEL_INVALID_STATE", `cannot ${action} while kernel is ${state}`);
  }

  /** 拆一个插件：先逆序跑它登记的清理，再调 deactivate。返回错误信息。 */
  async function teardown(entry: ActivatedEntry, callDeactivate: boolean): Promise<string[]> {
    const errors: string[] = [];
    for (const cleanup of [...entry.cleanups].reverse()) {
      try {
        await cleanup();
      } catch (error) {
        errors.push(messageOf(error));
      }
    }
    if (callDeactivate) {
      try {
        await entry.plugin.deactivate?.();
      } catch (error) {
        errors.push(messageOf(error));
      }
    }
    return errors;
  }

  async function rollback(failing: ActivatedEntry | null): Promise<KernelStartReport["rollbackErrors"]> {
    const rollbackErrors: { pluginId: string; message: string }[] = [];

    // 失败的那个插件可能已经登记了清理函数，得先收拾它自己的残留；
    // 但不调它的 deactivate——activate 都没跑完，deactivate 面对的是半个状态。
    if (failing) {
      for (const message of await teardown(failing, false)) {
        rollbackErrors.push({ pluginId: failing.plugin.id, message });
      }
    }

    for (const entry of [...activated].reverse()) {
      for (const message of await teardown(entry, true)) {
        rollbackErrors.push({ pluginId: entry.plugin.id, message });
      }
      record(entry.plugin.id).status = "rolledBack";
      events.publish({ type: "plugin.rolledBack", pluginId: entry.plugin.id });
    }
    activated.length = 0;

    for (const error of await registry.disposeAll()) {
      rollbackErrors.push({ pluginId: "", message: messageOf(error) });
    }
    return rollbackErrors;
  }

  return {
    get registry() {
      return view;
    },
    get events() {
      return events as KernelEventSource;
    },
    get state() {
      return state;
    },

    use(plugin) {
      assertUsable(`register plugin "${plugin.id}"`);
      if (records.has(plugin.id)) {
        throw new KernelError("PLUGIN_DUPLICATE_ID", `duplicate plugin id "${plugin.id}"`, {
          pluginId: plugin.id,
        });
      }
      plugins.push(plugin);
      records.set(plugin.id, {
        id: plugin.id,
        version: plugin.version,
        status: "pending",
        // 声明在这里就定下来：后面激活失败、被回滚，图里也还得有它。
        requires: (plugin.requires ?? []).map((token) => token.key),
        optional: (plugin.optional ?? []).map((token) => token.key),
        provides: (plugin.provides ?? []).map((token) => token.key),
      });
      return this;
    },

    async start() {
      assertUsable("start");
      state = "starting";
      const startedAt = now();

      const finish = (
        ok: boolean,
        failed: StartFailure[],
        rollbackErrors: KernelStartReport["rollbackErrors"],
      ): KernelStartReport => {
        state = ok ? "ready" : "failed";
        const report: KernelStartReport = {
          ok,
          state: ok ? "ready" : "failed",
          activated: activated.map((entry) => entry.plugin.id),
          failed,
          rollbackErrors,
          durationMs: now() - startedAt,
        };
        if (ok) events.publish({ type: "kernel.ready", durationMs: report.durationMs });
        else events.publish({ type: "kernel.failed", code: failed[0]?.code ?? "KERNEL_FAILED" });
        return report;
      };

      // 预检：缺硬依赖、供给方冲突、成环，都在这里失败——此时一个插件都还没激活。
      let ordered: AikaPlugin[];
      try {
        ordered = planActivation(plugins);
      } catch (error) {
        const code = codeOf(error, "PLUGIN_GRAPH_CYCLE");
        const pluginId = error instanceof KernelError
          ? String(error.details.pluginId ?? "")
          : "";
        for (const item of records.values()) item.status = "skipped";
        if (pluginId && records.has(pluginId)) {
          record(pluginId).status = "failed";
          record(pluginId).error = { code, message: messageOf(error) };
        }
        return finish(false, [{ pluginId, code, message: messageOf(error) }], await rollback(null));
      }

      for (const plugin of ordered) {
        const scoped = createScopedRegistrar(plugin, registry, events);
        const entry: ActivatedEntry = { plugin, cleanups: [] };
        const context: PluginContext = {
          registrar: scoped.registrar,
          events: events as KernelEventSource,
          logger,
          onDispose: (cleanup) => {
            entry.cleanups.push(cleanup);
          },
        };

        const pluginStartedAt = now();
        let failure: StartFailure | null = null;
        try {
          await plugin.activate(context);
          // 声明与事实必须一致：说了要提供却没提供，等于依赖图撒谎。
          const missing = (plugin.provides ?? [])
            .map((token) => token.key)
            .filter((key) => !scoped.providedKeys.has(key));
          if (missing.length) {
            throw new KernelError(
              "PLUGIN_CONTRACT_VIOLATION",
              `plugin "${plugin.id}" declared but never provided: ${missing.join(", ")}`,
              { pluginId: plugin.id, missing },
            );
          }
        } catch (error) {
          failure = {
            pluginId: plugin.id,
            code: codeOf(error, "PLUGIN_ACTIVATION_FAILED"),
            message: messageOf(error),
          };
        } finally {
          // 无论成败都收回：失败路径上更要收，免得插件在 catch 里继续注册。
          scoped.revoke();
        }

        if (failure) {
          record(plugin.id).status = "failed";
          record(plugin.id).error = { code: failure.code, message: failure.message };
          events.publish({
            type: "plugin.failed",
            pluginId: plugin.id,
            code: failure.code,
            message: failure.message,
          });
          for (const item of records.values()) {
            if (item.status === "pending") item.status = "skipped";
          }
          return finish(false, [failure], await rollback(entry));
        }

        activated.push(entry);
        record(plugin.id).status = "activated";
        events.publish({
          type: "plugin.activated",
          pluginId: plugin.id,
          durationMs: now() - pluginStartedAt,
        });
      }

      return finish(true, [], []);
    },

    async dispose() {
      if (state === "disposed") return;
      if (disposing) return disposing;

      disposing = (async () => {
        state = "disposing";
        for (const entry of [...activated].reverse()) {
          for (const message of await teardown(entry, true)) {
            // 释放中的异常不中断后续释放，收集后一并上报。
            logger.error("plugin teardown failed", { pluginId: entry.plugin.id, message });
          }
        }
        activated.length = 0;
        for (const error of await registry.disposeAll()) {
          logger.error("service disposer failed", { message: messageOf(error) });
        }
        state = "disposed";
        events.publish({ type: "kernel.disposed" });
      })();

      return disposing;
    },

    describe() {
      return buildSnapshot(state, [...records.values()], registry.entries());
    },
  };
}
