import { describe, expect, it } from "vitest";
import { isKernelError, KernelError } from "./errors";
import { createEventBus, type KernelEvent } from "./eventBus";
import { createScopedRegistrar, planActivation, type AikaPlugin } from "./plugin";
import { createRegistry } from "./registry";
import { token } from "./token";

const A = token<string>("test.a");
const B = token<string>("test.b");
const C = token<string>("test.c");

function stubPlugin(id: string, parts: Partial<AikaPlugin> = {}): AikaPlugin {
  return { id, version: "1.0.0", activate: () => undefined, ...parts };
}

describe("作用域注册器", () => {
  function setup(plugin: AikaPlugin) {
    const registry = createRegistry();
    const published: KernelEvent[] = [];
    const events = createEventBus();
    events.subscribe((event) => published.push(event));
    return { registry, published, scoped: createScopedRegistrar(plugin, registry, events) };
  }

  it("提供已声明的 token 会真正落到注册表，并发一条 service.registered", () => {
    const plugin = stubPlugin("p", { provides: [A] });
    const { registry, published, scoped } = setup(plugin);

    scoped.registrar.provide(A, () => "a");

    expect(registry.resolve(A)).toBe("a");
    expect(scoped.providedKeys.has("test.a")).toBe(true);
    expect(published).toEqual([{ type: "service.registered", key: "test.a", pluginId: "p" }]);
  });

  it("提供未声明的 token 抛 TOKEN_NOT_DECLARED，且不会偷偷注册进去", () => {
    const plugin = stubPlugin("p", { provides: [A] });
    const { registry, scoped } = setup(plugin);

    try {
      scoped.registrar.provide(B, () => "b");
      expect.unreachable("未声明的 provide 应当抛错");
    } catch (error) {
      expect(isKernelError(error, "TOKEN_NOT_DECLARED")).toBe(true);
    }
    expect(registry.has(B)).toBe(false);
  });

  it("resolve 越出 requires、tryResolve 越出 optional，都抛 DEPENDENCY_NOT_DECLARED", () => {
    const plugin = stubPlugin("p", { requires: [A], optional: [B] });
    const { registry, scoped } = setup(plugin);
    registry.register(A, "other", () => "a");
    registry.register(C, "other", () => "c");

    expect(scoped.registrar.resolve(A)).toBe("a");
    expect(scoped.registrar.tryResolve(B)).toBeNull();

    // 声明过 optional 的才准 tryResolve；C 一个字都没提过。
    expect(() => scoped.registrar.tryResolve(C)).toThrow(KernelError);
    // requires 与 optional 不互通：B 是软依赖，不能用 resolve 硬要。
    expect(() => scoped.registrar.resolve(B)).toThrow(KernelError);
  });

  it("软依赖存在时 tryResolve 拿得到实例", () => {
    const plugin = stubPlugin("p", { optional: [B] });
    const { registry, scoped } = setup(plugin);
    registry.register(B, "other", () => "b");

    expect(scoped.registrar.tryResolve(B)).toBe("b");
  });

  it("revoke 之后所有方法都抛 REGISTRAR_REVOKED：留着旧引用也调不动", () => {
    const plugin = stubPlugin("p", { provides: [A], requires: [B], optional: [C] });
    const { scoped } = setup(plugin);
    const escaped = scoped.registrar;

    scoped.revoke();

    for (const call of [
      () => escaped.provide(A, () => "a"),
      () => escaped.resolve(B),
      () => escaped.tryResolve(C),
    ]) {
      try {
        call();
        expect.unreachable("revoke 之后应当抛错");
      } catch (error) {
        expect(isKernelError(error, "REGISTRAR_REVOKED")).toBe(true);
      }
    }
  });
});

describe("激活顺序预检", () => {
  it("按 requires 排序：提供方一定排在消费方前面", () => {
    const provider = stubPlugin("provider", { provides: [A] });
    const consumer = stubPlugin("consumer", { requires: [A] });

    const ordered = planActivation([consumer, provider]).map((plugin) => plugin.id);

    expect(ordered).toEqual(["provider", "consumer"]);
  });

  it("optional 也参与排序，但缺供给方不算错误", () => {
    const provider = stubPlugin("provider", { provides: [A] });
    const consumer = stubPlugin("consumer", { optional: [A, B] });

    expect(planActivation([consumer, provider]).map((p) => p.id)).toEqual(["provider", "consumer"]);
    expect(planActivation([consumer]).map((p) => p.id)).toEqual(["consumer"]);
  });

  it("缺硬依赖时报出是谁要什么", () => {
    const consumer = stubPlugin("consumer", { requires: [A] });

    try {
      planActivation([consumer]);
      expect.unreachable("缺硬依赖应当抛错");
    } catch (error) {
      expect(isKernelError(error, "PLUGIN_DEPENDENCY_MISSING")).toBe(true);
      expect((error as KernelError).details).toMatchObject({
        pluginId: "consumer",
        key: "test.a",
      });
    }
  });

  it("两个插件抢同一个 token 在预检就失败，不留到注册时才炸", () => {
    const first = stubPlugin("first", { provides: [A] });
    const second = stubPlugin("second", { provides: [A] });

    try {
      planActivation([first, second]);
      expect.unreachable("供给方冲突应当抛错");
    } catch (error) {
      expect(isKernelError(error, "PLUGIN_PROVIDER_CONFLICT")).toBe(true);
      expect((error as KernelError).details.pluginIds).toEqual(["first", "second"]);
    }
  });

  it("成环时给出真实环路，而不是一堆卡住的节点", () => {
    const left = stubPlugin("left", { provides: [A], requires: [B] });
    const right = stubPlugin("right", { provides: [B], requires: [A] });

    try {
      planActivation([left, right]);
      expect.unreachable("成环应当抛错");
    } catch (error) {
      expect(isKernelError(error, "PLUGIN_GRAPH_CYCLE")).toBe(true);
      const chain = (error as KernelError).details.chain as string[];
      expect(chain.length).toBeGreaterThanOrEqual(3);
      expect(chain[0]).toBe(chain[chain.length - 1]);
    }
  });

  it("自己提供自己要的不算环", () => {
    const solo = stubPlugin("solo", { provides: [A], requires: [A] });

    expect(planActivation([solo]).map((p) => p.id)).toEqual(["solo"]);
  });

  it("重复 id 在预检就拦下", () => {
    try {
      planActivation([stubPlugin("dup"), stubPlugin("dup")]);
      expect.unreachable("重复 id 应当抛错");
    } catch (error) {
      expect(isKernelError(error, "PLUGIN_DUPLICATE_ID")).toBe(true);
    }
  });

  it("同一份输入永远排出同一个顺序", () => {
    const plugins = [
      stubPlugin("c", { requires: [B] }),
      stubPlugin("b", { provides: [B], requires: [A] }),
      stubPlugin("a", { provides: [A] }),
      stubPlugin("d"),
    ];

    const first = planActivation(plugins).map((p) => p.id);
    const second = planActivation(plugins).map((p) => p.id);

    expect(first).toEqual(second);
    expect(first.indexOf("a")).toBeLessThan(first.indexOf("b"));
    expect(first.indexOf("b")).toBeLessThan(first.indexOf("c"));
  });
});
