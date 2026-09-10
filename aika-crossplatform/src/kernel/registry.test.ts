import { describe, expect, it, vi } from "vitest";
import { isKernelError, KernelError } from "./errors";
import { createRegistry } from "./registry";
import { token } from "./token";

const A = token<{ name: string }>("test.a");
const B = token<{ name: string }>("test.b");
const C = token<{ name: string }>("test.c");

const openGate = () => null;

describe("ServiceRegistry", () => {
  it("惰性单例：不 resolve 就不建，建了只建一次", () => {
    const registry = createRegistry();
    const factory = vi.fn(() => ({ name: "a" }));
    registry.register(A, "p", factory);

    expect(factory).not.toHaveBeenCalled();

    const first = registry.resolve(A);
    const second = registry.resolve(A);

    expect(factory).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it("依赖在工厂里解析，拿到的仍是同一个单例", () => {
    const registry = createRegistry();
    const factory = vi.fn(() => ({ name: "a" }));
    registry.register(A, "p", factory);
    registry.register(B, "p", (context) => ({ name: `b:${context.resolve(A).name}` }));

    expect(registry.resolve(B).name).toBe("b:a");
    expect(registry.resolve(B)).toBe(registry.resolve(B));
    // A 被 B 的工厂建过一次，外面再要还是同一个。
    expect(factory).toHaveBeenCalledTimes(1);
    expect(registry.resolve(A).name).toBe("a");
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("重复注册直接抛，不静默覆盖——否则来源不可追溯", () => {
    const registry = createRegistry();
    registry.register(A, "first", () => ({ name: "1" }));

    try {
      registry.register(A, "second", () => ({ name: "2" }));
      expect.unreachable("重复注册应当抛错");
    } catch (error) {
      expect(isKernelError(error, "SERVICE_ALREADY_REGISTERED")).toBe(true);
      expect((error as KernelError).details).toMatchObject({
        key: "test.a",
        providedBy: "first",
        attemptedBy: "second",
      });
    }
    // 原注册没有被破坏。
    expect(registry.resolve(A).name).toBe("1");
  });

  it("未注册的服务抛 SERVICE_NOT_REGISTERED，不返回 undefined", () => {
    const registry = createRegistry();
    try {
      registry.resolve(A);
      expect.unreachable("未注册应当抛错");
    } catch (error) {
      expect(isKernelError(error, "SERVICE_NOT_REGISTERED")).toBe(true);
    }
  });

  it("成环时给出完整依赖链，而不是栈溢出", () => {
    const registry = createRegistry();
    registry.register(A, "p", (context) => ({ name: context.resolve(B).name }));
    registry.register(B, "p", (context) => ({ name: context.resolve(C).name }));
    registry.register(C, "p", (context) => ({ name: context.resolve(A).name }));

    try {
      registry.resolve(A);
      expect.unreachable("成环应当抛错");
    } catch (error) {
      expect(isKernelError(error, "SERVICE_CYCLE")).toBe(true);
      expect((error as KernelError).details.chain).toEqual(["test.a", "test.b", "test.c", "test.a"]);
    }
  });

  it("工厂抛错不写缓存，修好后下次能重来", () => {
    const registry = createRegistry();
    let broken = true;
    registry.register(A, "p", () => {
      if (broken) throw new Error("boom");
      return { name: "ok" };
    });

    expect(() => registry.resolve(A)).toThrow("boom");
    broken = false;
    expect(registry.resolve(A).name).toBe("ok");
  });

  it("只读视图上没有任何写入方法：注册的唯一入口是插件的作用域注册器", () => {
    const registry = createRegistry();
    const view = registry.createView(openGate);

    expect("register" in view).toBe(false);
    expect(Object.keys(view).sort()).toEqual(["has", "resolve", "tryResolve"]);
  });

  it("状态门拦住半装配的服务；has 是纯查询不设门", () => {
    const registry = createRegistry();
    registry.register(A, "p", () => ({ name: "a" }));
    const view = registry.createView(() => new KernelError("KERNEL_NOT_READY", "not ready"));

    expect(view.has(A)).toBe(true);
    expect(() => view.resolve(A)).toThrow(KernelError);
    expect(() => view.tryResolve(A)).toThrow(KernelError);
  });

  it("tryResolve 对未注册的返回 null，对已注册的照常建", () => {
    const registry = createRegistry();
    registry.register(A, "p", () => ({ name: "a" }));
    const view = registry.createView(openGate);

    expect(view.tryResolve(B)).toBeNull();
    expect(view.tryResolve(A)?.name).toBe("a");
  });

  it("释放按实例化逆序，且不为了释放去实例化没人用过的服务", async () => {
    const registry = createRegistry();
    const order: string[] = [];
    const unusedFactory = vi.fn(() => ({ name: "c" }));

    registry.register(A, "p", () => ({ name: "a" }), { disposer: () => void order.push("a") });
    registry.register(B, "p", () => ({ name: "b" }), { disposer: () => void order.push("b") });
    registry.register(C, "p", unusedFactory, { disposer: () => void order.push("c") });

    registry.resolve(A);
    registry.resolve(B);
    const errors = await registry.disposeAll();

    expect(errors).toEqual([]);
    expect(order).toEqual(["b", "a"]);
    expect(unusedFactory).not.toHaveBeenCalled();
  });

  it("某个 disposer 炸了不中断后续释放，错误一并返回", async () => {
    const registry = createRegistry();
    const order: string[] = [];
    registry.register(A, "p", () => ({ name: "a" }), { disposer: () => void order.push("a") });
    registry.register(B, "p", () => ({ name: "b" }), {
      disposer: () => {
        throw new Error("dispose boom");
      },
    });

    registry.resolve(A);
    registry.resolve(B);
    const errors = await registry.disposeAll();

    expect(errors).toHaveLength(1);
    expect(order).toEqual(["a"]);
  });

  it("entries 在未实例化时就能报出 token 与提供方", () => {
    const registry = createRegistry();
    registry.register(A, "alpha", () => ({ name: "a" }));

    expect(registry.entries()).toEqual([
      { key: "test.a", providedBy: "alpha", instantiated: false },
    ]);
    registry.resolve(A);
    expect(registry.entries()[0].instantiated).toBe(true);
  });
});
