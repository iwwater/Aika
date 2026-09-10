import { KernelError } from "./errors";
import type { ServiceToken } from "./token";

/**
 * 服务注册表。
 *
 * 对外只读：`ServiceRegistry` 上没有任何写入方法。写入的唯一入口是插件在
 * activate 期间拿到的作用域注册器（见 plugin.ts）。这样「谁提供了这个服务」
 * 永远只有一个答案，也不可能有人在运行中途偷偷换掉一个实现。
 *
 * 只有单例作用域。会话级实例等真出现第二个并发会话时再说，不提前抽象。
 */

export interface ResolveContext {
  resolve<T>(token: ServiceToken<T>): T;
}

export interface ServiceRegistry {
  has(token: ServiceToken<unknown>): boolean;
  /** 未注册即抛 SERVICE_NOT_REGISTERED，不返回 undefined 让调用方自己猜。 */
  resolve<T>(token: ServiceToken<T>): T;
  tryResolve<T>(token: ServiceToken<T>): T | null;
}

export interface RegisterOptions<T> {
  disposer?: (value: T) => void | Promise<void>;
}

export interface RegistryEntrySnapshot {
  key: string;
  providedBy: string;
  instantiated: boolean;
}

interface Registration {
  key: string;
  providedBy: string;
  factory: (context: ResolveContext) => unknown;
  disposer?: (value: never) => void | Promise<void>;
  instantiated: boolean;
  value?: unknown;
}

export interface InternalRegistry {
  register<T>(
    token: ServiceToken<T>,
    providedBy: string,
    factory: (context: ResolveContext) => T,
    options?: RegisterOptions<T>,
  ): void;
  has(token: ServiceToken<unknown>): boolean;
  /** 不过状态门：给作用域注册器与服务工厂内部用。 */
  resolve<T>(token: ServiceToken<T>): T;
  entries(): RegistryEntrySnapshot[];
  /** 按实例化的逆序释放；只碰已实例化的，未被 resolve 过的工厂不为了释放而执行。 */
  disposeAll(): Promise<unknown[]>;
  /** 生成带状态门的只读视图：内核未 ready 或已失败时，半装配的服务不许流出去。 */
  createView(gate: () => KernelError | null): ServiceRegistry;
}

export function createRegistry(): InternalRegistry {
  const registrations = new Map<string, Registration>();
  /** 当前解析链，用于成环检测；同时也是错误里那条链的来源。 */
  const resolving: string[] = [];
  /** 实例化顺序，dispose 时逆序走一遍。 */
  const instantiated: string[] = [];

  const context: ResolveContext = {
    resolve: (token) => resolve(token),
  };

  function resolve<T>(token: ServiceToken<T>): T {
    const registration = registrations.get(token.key);
    if (!registration) {
      throw new KernelError(
        "SERVICE_NOT_REGISTERED",
        `service "${token.key}" is not registered`,
        { key: token.key },
      );
    }
    if (registration.instantiated) return registration.value as T;

    if (resolving.includes(token.key)) {
      const chain = [...resolving, token.key];
      throw new KernelError(
        "SERVICE_CYCLE",
        `service dependency cycle: ${chain.join(" -> ")}`,
        { chain },
      );
    }

    resolving.push(token.key);
    let value: unknown;
    try {
      value = registration.factory(context);
    } finally {
      resolving.pop();
    }

    // 工厂抛错时这里不会执行：失败不缓存，下次 resolve 会重试。
    registration.instantiated = true;
    registration.value = value;
    instantiated.push(token.key);
    return value as T;
  }

  return {
    register(token, providedBy, factory, options) {
      const existing = registrations.get(token.key);
      if (existing) {
        // 静默覆盖会让「谁提供了这个服务」不可追溯，所以宁可炸。
        throw new KernelError(
          "SERVICE_ALREADY_REGISTERED",
          `service "${token.key}" is already provided by "${existing.providedBy}"`,
          { key: token.key, providedBy: existing.providedBy, attemptedBy: providedBy },
        );
      }
      registrations.set(token.key, {
        key: token.key,
        providedBy,
        factory: factory as (context: ResolveContext) => unknown,
        disposer: options?.disposer as ((value: never) => void | Promise<void>) | undefined,
        instantiated: false,
      });
    },

    has(token) {
      return registrations.has(token.key);
    },

    resolve,

    entries() {
      return [...registrations.values()].map((registration) => ({
        key: registration.key,
        providedBy: registration.providedBy,
        instantiated: registration.instantiated,
      }));
    },

    async disposeAll() {
      const errors: unknown[] = [];
      // 逆序：后建的通常依赖先建的，先拆后建的才安全。
      for (const key of [...instantiated].reverse()) {
        const registration = registrations.get(key);
        if (!registration?.instantiated) continue;
        try {
          await registration.disposer?.(registration.value as never);
        } catch (error) {
          // 一个 disposer 炸了不能中断后面的释放，收集起来一并上报。
          errors.push(error);
        }
        registration.instantiated = false;
        registration.value = undefined;
      }
      instantiated.length = 0;
      return errors;
    },

    createView(gate) {
      return {
        // has 是纯查询，不会漏出实例，因此不设门。
        has: (token) => registrations.has(token.key),
        resolve: (token) => {
          const blocked = gate();
          if (blocked) throw blocked;
          return resolve(token);
        },
        tryResolve: (token) => {
          const blocked = gate();
          if (blocked) throw blocked;
          return registrations.has(token.key) ? resolve(token) : null;
        },
      };
    },
  };
}
