import { KernelError } from "./errors";
import type { InternalEventBus, KernelEventSource } from "./eventBus";
import type { InternalRegistry, RegisterOptions, ResolveContext } from "./registry";
import type { ServiceToken } from "./token";

/**
 * 插件契约。
 *
 * 插件对内核而言只是一份声明加两个回调。内核不检查它提供的是「什么」——
 * 那是业务，内核不认识——只检查**它说的和它做的是否一致**：
 * 声明了要提供就必须提供，没声明的不许提供，没声明的依赖不许拿。
 *
 * 声明即依赖图，依赖图即事实。否则拓扑排序排的是一张想象中的图。
 */

export interface AikaPlugin {
  readonly id: string;
  readonly version: string;
  /** 硬依赖：缺一个就排不出序，启动直接失败。 */
  readonly requires?: readonly ServiceToken<unknown>[];
  /** 软依赖：允许缺供给方，缺时只能经 tryResolve 拿到 null。 */
  readonly optional?: readonly ServiceToken<unknown>[];
  readonly provides?: readonly ServiceToken<unknown>[];
  activate(context: PluginContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}

export interface KernelLogger {
  debug(message: string, details?: Record<string, unknown>): void;
  warn(message: string, details?: Record<string, unknown>): void;
  error(message: string, details?: Record<string, unknown>): void;
}

/**
 * 作用域注册器。
 *
 * 插件拿不到「所有服务」这种东西，只能碰自己声明过的那几个；activate 一返回
 * 这个对象就失效，留着旧引用也调不动。这是能力回收，不是在共享注册表上翻一个
 * 布尔位——后者只要有人拿到注册表引用就能绕过去。
 */
export interface PluginRegistrar {
  /** token 不在 provides 里，抛 TOKEN_NOT_DECLARED。 */
  provide<T>(
    token: ServiceToken<T>,
    factory: (context: ResolveContext) => T,
    options?: RegisterOptions<T>,
  ): void;
  /** token 不在 requires 里，抛 DEPENDENCY_NOT_DECLARED。 */
  resolve<T>(token: ServiceToken<T>): T;
  /** token 不在 optional 里，抛 DEPENDENCY_NOT_DECLARED；缺供给方时返回 null。 */
  tryResolve<T>(token: ServiceToken<T>): T | null;
}

export interface PluginContext {
  readonly registrar: PluginRegistrar;
  readonly events: KernelEventSource;
  readonly logger: KernelLogger;
  onDispose(cleanup: () => void | Promise<void>): void;
}

export function createNoopLogger(): KernelLogger {
  return {
    debug: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}

function keySet(tokens: readonly ServiceToken<unknown>[] | undefined): Set<string> {
  return new Set((tokens ?? []).map((token) => token.key));
}

export interface ScopedRegistrar {
  registrar: PluginRegistrar;
  /** activate 返回后调用；之后该 registrar 的任何方法都抛 REGISTRAR_REVOKED。 */
  revoke(): void;
  /** 实际注册成功的 key，用来核对声明与事实是否一致。 */
  providedKeys: ReadonlySet<string>;
}

export function createScopedRegistrar(
  plugin: AikaPlugin,
  registry: InternalRegistry,
  events: InternalEventBus,
): ScopedRegistrar {
  const declaredProvides = keySet(plugin.provides);
  const declaredRequires = keySet(plugin.requires);
  const declaredOptional = keySet(plugin.optional);
  const provided = new Set<string>();
  let revoked = false;

  function assertLive(): void {
    if (revoked) {
      throw new KernelError(
        "REGISTRAR_REVOKED",
        `plugin "${plugin.id}" used its registrar after activate() returned`,
        { pluginId: plugin.id },
      );
    }
  }

  return {
    providedKeys: provided,
    revoke() {
      revoked = true;
    },
    registrar: {
      provide(token, factory, options) {
        assertLive();
        if (!declaredProvides.has(token.key)) {
          throw new KernelError(
            "TOKEN_NOT_DECLARED",
            `plugin "${plugin.id}" provided "${token.key}" without declaring it in provides`,
            { pluginId: plugin.id, key: token.key },
          );
        }
        registry.register(token, plugin.id, factory, options);
        provided.add(token.key);
        events.publish({ type: "service.registered", key: token.key, pluginId: plugin.id });
      },
      resolve(token) {
        assertLive();
        if (!declaredRequires.has(token.key)) {
          throw new KernelError(
            "DEPENDENCY_NOT_DECLARED",
            `plugin "${plugin.id}" resolved "${token.key}" without declaring it in requires`,
            { pluginId: plugin.id, key: token.key },
          );
        }
        return registry.resolve(token);
      },
      tryResolve(token) {
        assertLive();
        if (!declaredOptional.has(token.key)) {
          // 软依赖也要先声明：否则「谁可能用到什么」在声明里看不出来，
          // 依赖图就又变回猜的了。
          throw new KernelError(
            "DEPENDENCY_NOT_DECLARED",
            `plugin "${plugin.id}" tried "${token.key}" without declaring it in optional`,
            { pluginId: plugin.id, key: token.key },
          );
        }
        return registry.has(token) ? registry.resolve(token) : null;
      },
    },
  };
}

/**
 * 激活顺序预检。
 *
 * 全部在**激活任何插件之前**完成：缺硬依赖、供给方冲突、成环，都在这里失败，
 * 这样失败时系统还是干净的，没有半启动状态需要收拾。
 *
 * optional 也参与排序并同样受成环检查约束。不做「遇环就忽略软边」——那会让
 * 激活顺序随依赖变化而不可预测，出问题时根本没法复现。
 */
export function planActivation(plugins: readonly AikaPlugin[]): AikaPlugin[] {
  const byId = new Map<string, AikaPlugin>();
  for (const plugin of plugins) {
    if (byId.has(plugin.id)) {
      throw new KernelError("PLUGIN_DUPLICATE_ID", `duplicate plugin id "${plugin.id}"`, {
        pluginId: plugin.id,
      });
    }
    byId.set(plugin.id, plugin);
  }

  const providerOf = new Map<string, string>();
  for (const plugin of plugins) {
    for (const token of plugin.provides ?? []) {
      const existing = providerOf.get(token.key);
      if (existing) {
        throw new KernelError(
          "PLUGIN_PROVIDER_CONFLICT",
          `"${token.key}" is declared by both "${existing}" and "${plugin.id}"`,
          { key: token.key, pluginId: plugin.id, pluginIds: [existing, plugin.id] },
        );
      }
      providerOf.set(token.key, plugin.id);
    }
  }

  // dependents: 提供方 -> 依赖它的插件；indegree 按依赖数计。
  const dependents = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const plugin of plugins) indegree.set(plugin.id, 0);

  function addEdge(from: string, to: string): void {
    if (from === to) return; // 自己提供自己要的，不构成排序约束。
    const list = dependents.get(from) ?? [];
    list.push(to);
    dependents.set(from, list);
    indegree.set(to, (indegree.get(to) ?? 0) + 1);
  }

  for (const plugin of plugins) {
    for (const token of plugin.requires ?? []) {
      const provider = providerOf.get(token.key);
      if (!provider) {
        throw new KernelError(
          "PLUGIN_DEPENDENCY_MISSING",
          `plugin "${plugin.id}" requires "${token.key}", which no plugin provides`,
          { pluginId: plugin.id, key: token.key },
        );
      }
      addEdge(provider, plugin.id);
    }
    for (const token of plugin.optional ?? []) {
      const provider = providerOf.get(token.key);
      // 缺供给方不是错误，只是少一条边。
      if (provider) addEdge(provider, plugin.id);
    }
  }

  // Kahn；就绪集合按声明顺序取，保证同一份输入永远排出同一个顺序。
  const ordered: AikaPlugin[] = [];
  const ready = plugins.filter((plugin) => (indegree.get(plugin.id) ?? 0) === 0).map((p) => p.id);
  while (ready.length) {
    const id = ready.shift() as string;
    ordered.push(byId.get(id) as AikaPlugin);
    for (const next of dependents.get(id) ?? []) {
      const remaining = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) ready.push(next);
    }
  }

  if (ordered.length !== plugins.length) {
    const stuck = plugins.filter((plugin) => (indegree.get(plugin.id) ?? 0) > 0).map((p) => p.id);
    const chain = findCycle(stuck, dependents);
    throw new KernelError(
      "PLUGIN_GRAPH_CYCLE",
      `plugin dependency cycle: ${chain.join(" -> ")}`,
      { chain, pluginId: chain[0] ?? "" },
    );
  }
  return ordered;
}

/** 从卡住的节点里挖出一条真实的环，错误里给链比给集合有用得多。 */
function findCycle(stuck: readonly string[], dependents: Map<string, string[]>): string[] {
  const inStuck = new Set(stuck);
  const path: string[] = [];
  const onPath = new Set<string>();
  const visited = new Set<string>();

  function walk(id: string): string[] | null {
    if (onPath.has(id)) return [...path.slice(path.indexOf(id)), id];
    if (visited.has(id)) return null;
    visited.add(id);
    onPath.add(id);
    path.push(id);
    for (const next of dependents.get(id) ?? []) {
      if (!inStuck.has(next)) continue;
      const found = walk(next);
      if (found) return found;
    }
    path.pop();
    onPath.delete(id);
    return null;
  }

  for (const id of stuck) {
    const found = walk(id);
    if (found) return found;
  }
  return [...stuck];
}
