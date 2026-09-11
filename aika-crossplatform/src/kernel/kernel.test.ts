import { describe, expect, it, vi } from "vitest";
import { createKernel } from "./kernel";
import { isKernelError, KernelError, type KernelErrorCode } from "./errors";
import type { KernelEvent } from "./eventBus";
import type { AikaPlugin, KernelLogger, PluginContext, PluginRegistrar } from "./plugin";
import { token } from "./token";

const A = token<string>("test.a");
const B = token<string>("test.b");

function capturingLogger(): KernelLogger & { errors: string[] } {
  const errors: string[] = [];
  return {
    errors,
    debug: () => undefined,
    warn: () => undefined,
    error: (message, details) => {
      errors.push(`${message}:${String(details?.message ?? "")}`);
    },
  };
}

/** 记事插件：把自己被怎么对待记进共享的 trace 里。 */
function tracingPlugin(
  id: string,
  trace: string[],
  parts: Partial<AikaPlugin> = {},
): AikaPlugin {
  return {
    id,
    version: "1.0.0",
    activate(context) {
      trace.push(`${id}:activate`);
      context.onDispose(() => void trace.push(`${id}:cleanup`));
    },
    deactivate() {
      trace.push(`${id}:deactivate`);
    },
    ...parts,
  };
}

function expectCode(error: unknown, code: KernelErrorCode): void {
  expect(isKernelError(error, code), `expected ${code}, got ${String(error)}`).toBe(true);
}

describe("内核生命周期", () => {
  it("created → starting → ready，服务在 ready 之后才拿得到", async () => {
    const kernel = createKernel();
    expect(kernel.state).toBe("created");

    kernel.use({
      id: "provider",
      version: "1.0.0",
      provides: [A],
      activate: (context) => context.registrar.provide(A, () => "a"),
    });

    // ready 之前不许把半装配的服务放出去。
    try {
      kernel.registry.resolve(A);
      expect.unreachable("ready 之前 resolve 应当抛错");
    } catch (error) {
      expectCode(error, "KERNEL_NOT_READY");
    }

    const report = await kernel.start();

    expect(report.ok).toBe(true);
    expect(report.state).toBe("ready");
    expect(report.activated).toEqual(["provider"]);
    expect(report.failed).toEqual([]);
    expect(kernel.state).toBe("ready");
    expect(kernel.registry.resolve(A)).toBe("a");
  });

  it("按拓扑顺序激活，消费方能拿到提供方的服务", async () => {
    const trace: string[] = [];
    const kernel = createKernel();
    kernel.use({
      id: "consumer",
      version: "1.0.0",
      requires: [A],
      provides: [B],
      activate(context) {
        trace.push(`consumer:${context.registrar.resolve(A)}`);
        context.registrar.provide(B, () => "b");
      },
    });
    kernel.use({
      id: "provider",
      version: "1.0.0",
      provides: [A],
      activate: (context) => context.registrar.provide(A, () => "a"),
    });

    const report = await kernel.start();

    expect(report.ok).toBe(true);
    expect(report.activated).toEqual(["provider", "consumer"]);
    expect(trace).toEqual(["consumer:a"]);
  });

  it("服务是惰性的：没人 resolve 就不实例化，但 describe 已经能报出来", async () => {
    const factory = vi.fn(() => "a");
    const kernel = createKernel();
    kernel.use({
      id: "provider",
      version: "1.0.0",
      provides: [A],
      activate: (context) => context.registrar.provide(A, factory),
    });
    await kernel.start();

    expect(factory).not.toHaveBeenCalled();
    expect(kernel.describe().services).toEqual([
      { key: "test.a", providedBy: "provider", instantiated: false },
    ]);

    kernel.registry.resolve(A);
    expect(kernel.describe().services[0].instantiated).toBe(true);
  });
});

describe("启动失败与回滚", () => {
  it("插件抛错：已激活的按逆序拆干净，状态落到 failed", async () => {
    const trace: string[] = [];
    const kernel = createKernel();
    kernel.use(tracingPlugin("first", trace, { provides: [A],
      activate(context) {
        trace.push("first:activate");
        context.registrar.provide(A, () => "a");
        context.onDispose(() => void trace.push("first:cleanup"));
      },
    }));
    kernel.use(tracingPlugin("second", trace, { requires: [A],
      activate(context) {
        trace.push("second:activate");
        context.onDispose(() => void trace.push("second:cleanup"));
        throw new Error("boom");
      },
    }));

    const report = await kernel.start();

    expect(report.ok).toBe(false);
    expect(report.state).toBe("failed");
    expect(kernel.state).toBe("failed");
    expect(report.failed).toEqual([
      { pluginId: "second", code: "PLUGIN_ACTIVATION_FAILED", message: "boom" },
    ]);
    // 失败者自己的清理先跑，但不调它的 deactivate（activate 都没跑完）；
    // 然后已激活的逆序拆。
    expect(trace).toEqual([
      "first:activate", "second:activate",
      "second:cleanup", "first:cleanup", "first:deactivate",
    ]);
  });

  it("失败之后服务不许再流出去，也不允许原地重试", async () => {
    const kernel = createKernel();
    kernel.use({
      id: "broken",
      version: "1.0.0",
      activate: () => {
        throw new Error("boom");
      },
    });

    await kernel.start();

    for (const call of [
      () => kernel.registry.resolve(A),
      () => kernel.use({ id: "late", version: "1.0.0", activate: () => undefined }),
      () => kernel.start(),
    ]) {
      try {
        const result = call();
        if (result instanceof Promise) await result;
        expect.unreachable("failed 之后应当抛错");
      } catch (error) {
        expectCode(error, "KERNEL_FAILED");
      }
    }
  });

  it("声明了 provides 却没提供，判该插件违约并回滚", async () => {
    const trace: string[] = [];
    const kernel = createKernel();
    kernel.use(tracingPlugin("good", trace));
    kernel.use({
      id: "liar",
      version: "1.0.0",
      provides: [A],
      activate: () => undefined,
    });

    const report = await kernel.start();

    expect(report.ok).toBe(false);
    expect(report.failed[0].pluginId).toBe("liar");
    expect(report.failed[0].code).toBe("PLUGIN_CONTRACT_VIOLATION");
    expect(trace).toEqual(["good:activate", "good:cleanup", "good:deactivate"]);
  });

  it("预检失败时一个插件都没激活，全部记为 skipped", async () => {
    const trace: string[] = [];
    const kernel = createKernel();
    kernel.use(tracingPlugin("orphan", trace, { requires: [A] }));

    const report = await kernel.start();

    expect(report.ok).toBe(false);
    expect(report.failed[0].code).toBe("PLUGIN_DEPENDENCY_MISSING");
    expect(trace).toEqual([]);
    expect(kernel.describe().plugins[0].status).toBe("failed");
  });

  it("回滚时 deactivate 自己摔跤，单独记进 rollbackErrors 且不中断后续回滚", async () => {
    const trace: string[] = [];
    const kernel = createKernel();
    kernel.use({
      id: "grumpy",
      version: "1.0.0",
      provides: [A],
      activate: (context) => context.registrar.provide(A, () => "a"),
      deactivate: () => {
        throw new Error("teardown boom");
      },
    });
    kernel.use(tracingPlugin("tidy", trace, { requires: [A] }));
    kernel.use({
      id: "broken",
      version: "1.0.0",
      requires: [A],
      activate: () => {
        throw new Error("boom");
      },
    });

    const report = await kernel.start();

    expect(report.ok).toBe(false);
    expect(report.rollbackErrors).toEqual([
      { pluginId: "grumpy", message: "teardown boom" },
    ]);
    // grumpy 摔了不影响 tidy 被拆干净。
    expect(trace).toEqual(["tidy:activate", "tidy:cleanup", "tidy:deactivate"]);
  });

  it("activate 返回后 registrar 立即失效，插件留着旧引用也用不了", async () => {
    let escaped: PluginRegistrar | null = null;
    const kernel = createKernel();
    kernel.use({
      id: "sneaky",
      version: "1.0.0",
      provides: [A],
      activate(context: PluginContext) {
        context.registrar.provide(A, () => "a");
        escaped = context.registrar;
      },
    });

    await kernel.start();

    const registrar = escaped as PluginRegistrar | null;
    expect(registrar).not.toBeNull();
    try {
      registrar?.provide(B, () => "b");
      expect.unreachable("revoke 之后应当抛错");
    } catch (error) {
      expectCode(error, "REGISTRAR_REVOKED");
    }
    expect(kernel.registry.has(B)).toBe(false);
  });
});

describe("释放", () => {
  it("逆序释放：后激活的先拆，服务 disposer 也跟着走", async () => {
    const trace: string[] = [];
    const kernel = createKernel();
    kernel.use({
      id: "first",
      version: "1.0.0",
      provides: [A],
      activate(context) {
        trace.push("first:activate");
        context.registrar.provide(A, () => "a", { disposer: () => void trace.push("a:dispose") });
        context.onDispose(() => void trace.push("first:cleanup"));
      },
      deactivate: () => void trace.push("first:deactivate"),
    });
    kernel.use(tracingPlugin("second", trace, { requires: [A],
      activate(context) {
        trace.push("second:activate");
        context.registrar.resolve(A);
        context.onDispose(() => void trace.push("second:cleanup"));
      },
    }));

    await kernel.start();
    await kernel.dispose();

    expect(kernel.state).toBe("disposed");
    expect(trace).toEqual([
      "first:activate", "second:activate",
      "second:cleanup", "second:deactivate",
      "first:cleanup", "first:deactivate",
      "a:dispose",
    ]);
  });

  it("dispose 幂等：再调一次什么都不会重复跑", async () => {
    const trace: string[] = [];
    const kernel = createKernel();
    kernel.use(tracingPlugin("only", trace));

    await kernel.start();
    await kernel.dispose();
    await kernel.dispose();
    await Promise.all([kernel.dispose(), kernel.dispose()]);

    expect(trace).toEqual(["only:activate", "only:cleanup", "only:deactivate"]);
  });

  it("failed 之后仍然可以 dispose，且不会把已回滚的再拆一遍", async () => {
    const trace: string[] = [];
    const kernel = createKernel();
    kernel.use(tracingPlugin("good", trace));
    kernel.use({
      id: "broken",
      version: "1.0.0",
      activate: () => {
        throw new Error("boom");
      },
    });

    await kernel.start();
    expect(kernel.state).toBe("failed");

    await kernel.dispose();

    expect(kernel.state).toBe("disposed");
    expect(trace).toEqual(["good:activate", "good:cleanup", "good:deactivate"]);
  });

  it("释放中的异常不中断后续释放，收集后一并上报", async () => {
    const logger = capturingLogger();
    const trace: string[] = [];
    const kernel = createKernel({ logger });
    kernel.use({
      id: "grumpy",
      version: "1.0.0",
      activate: () => undefined,
      deactivate: () => {
        throw new Error("teardown boom");
      },
    });
    kernel.use(tracingPlugin("tidy", trace));

    await kernel.start();
    await kernel.dispose();

    expect(kernel.state).toBe("disposed");
    expect(trace).toEqual(["tidy:activate", "tidy:cleanup", "tidy:deactivate"]);
    expect(logger.errors.some((line) => line.includes("teardown boom"))).toBe(true);
  });

  it("从未 start 过也能 dispose", async () => {
    const kernel = createKernel();
    await kernel.dispose();
    expect(kernel.state).toBe("disposed");
  });
});

describe("事件与诊断", () => {
  it("成功启动的事件序列完整，且 kernel.ready 只发一次", async () => {
    const seen: KernelEvent[] = [];
    const kernel = createKernel({ now: (() => {
      let tick = 0;
      return () => (tick += 10);
    })() });
    kernel.events.subscribe((event) => seen.push(event));
    kernel.use({
      id: "provider",
      version: "1.0.0",
      provides: [A],
      activate: (context) => context.registrar.provide(A, () => "a"),
    });

    const report = await kernel.start();
    await kernel.dispose();

    expect(seen.map((event) => event.type)).toEqual([
      "service.registered", "plugin.activated", "kernel.ready", "kernel.disposed",
    ]);
    expect(report.durationMs).toBeGreaterThan(0);
  });

  it("失败时发 plugin.failed 与 kernel.failed，不发 kernel.ready", async () => {
    const seen: KernelEvent[] = [];
    const kernel = createKernel();
    kernel.events.subscribe((event) => seen.push(event));
    kernel.use({
      id: "good",
      version: "1.0.0",
      provides: [A],
      activate: (context) => context.registrar.provide(A, () => "a"),
    });
    kernel.use({
      id: "broken",
      version: "1.0.0",
      requires: [A],
      activate: () => {
        throw new Error("boom");
      },
    });

    await kernel.start();

    const types = seen.map((event) => event.type);
    expect(types).toContain("plugin.failed");
    expect(types).toContain("plugin.rolledBack");
    expect(types).toContain("kernel.failed");
    expect(types).not.toContain("kernel.ready");
  });

  it("一个坏订阅者不拖垮启动", async () => {
    const logger = capturingLogger();
    const kernel = createKernel({ logger });
    kernel.events.subscribe(() => {
      throw new Error("listener boom");
    });
    const seen: KernelEvent[] = [];
    kernel.events.subscribe((event) => seen.push(event));
    kernel.use({ id: "solo", version: "1.0.0", activate: () => undefined });

    const report = await kernel.start();

    expect(report.ok).toBe(true);
    expect(seen.map((event) => event.type)).toEqual(["plugin.activated", "kernel.ready"]);
    expect(logger.errors.some((line) => line.includes("listener boom"))).toBe(true);
  });

  it("describe 在每个状态下都可用，failed 时指得出是谁、什么码", async () => {
    const kernel = createKernel();
    expect(kernel.describe().state).toBe("created");

    kernel.use({ id: "good", version: "1.0.0", activate: () => undefined });
    kernel.use({
      id: "broken",
      version: "2.0.0",
      activate: () => {
        throw new KernelError("PLUGIN_CONTRACT_VIOLATION", "nope");
      },
    });

    await kernel.start();

    const failedSnapshot = kernel.describe();
    expect(failedSnapshot.state).toBe("failed");
    // CORE-09：三份声明也在这里，失败与被回滚的插件同样带着（图里要看得见谁没装上）。
    expect(failedSnapshot.plugins).toEqual([
      { id: "good", version: "1.0.0", status: "rolledBack", requires: [], optional: [], provides: [] },
      {
        id: "broken",
        version: "2.0.0",
        status: "failed",
        error: { code: "PLUGIN_CONTRACT_VIOLATION", message: "nope" },
        requires: [], optional: [], provides: [],
      },
    ]);

    await kernel.dispose();
    expect(kernel.describe().state).toBe("disposed");
  });

  it("快照是拷贝，改它不会污染内核状态", async () => {
    const kernel = createKernel();
    kernel.use({ id: "solo", version: "1.0.0", activate: () => undefined });
    await kernel.start();

    const snapshot = kernel.describe();
    snapshot.plugins[0].status = "failed";

    expect(kernel.describe().plugins[0].status).toBe("activated");
  });

  it("重复 id 在 use 阶段就拦下", () => {
    const kernel = createKernel();
    kernel.use({ id: "dup", version: "1.0.0", activate: () => undefined });

    try {
      kernel.use({ id: "dup", version: "1.0.0", activate: () => undefined });
      expect.unreachable("重复 id 应当抛错");
    } catch (error) {
      expectCode(error, "PLUGIN_DUPLICATE_ID");
    }
  });

  it("ready 之后不能再 use，也不能再 start", async () => {
    const kernel = createKernel();
    await kernel.start();

    try {
      kernel.use({ id: "late", version: "1.0.0", activate: () => undefined });
      expect.unreachable("ready 之后 use 应当抛错");
    } catch (error) {
      expectCode(error, "KERNEL_INVALID_STATE");
    }
    await expect(kernel.start()).rejects.toThrow(KernelError);
  });
});

describe("CORE-09 · 装配拓扑可读", () => {
  const alpha = token<string>("topology.alpha");
  const beta = token<string>("topology.beta");
  const missing = token<string>("topology.missing");

  it("三份声明按 token key 出现在快照里；没声明的是空数组", async () => {
    const kernel = createKernel();
    kernel.use({
      id: "provider",
      version: "1.0.0",
      provides: [alpha],
      activate: (context) => {
        context.registrar.provide(alpha, () => "A");
      },
    });
    kernel.use({
      id: "consumer",
      version: "1.0.0",
      requires: [alpha],
      optional: [missing],
      provides: [beta],
      activate: (context) => {
        context.registrar.provide(beta, () => "B");
      },
    });
    kernel.use({ id: "loner", version: "1.0.0", activate: () => undefined });

    await kernel.start();
    const snapshot = kernel.describe();
    const byId = new Map(snapshot.plugins.map((plugin) => [plugin.id, plugin]));

    expect(byId.get("consumer")).toMatchObject({
      requires: ["topology.alpha"],
      optional: ["topology.missing"],
      provides: ["topology.beta"],
    });
    // 没声明的是空数组而不是 undefined：画图的一方不该到处写 ?? []。
    expect(byId.get("loner")).toMatchObject({ requires: [], optional: [], provides: [] });
    await kernel.dispose();
  });

  it("provides 与 services 的 providedBy 对得上", async () => {
    const kernel = createKernel();
    kernel.use({
      id: "provider",
      version: "1.0.0",
      provides: [alpha],
      activate: (context) => {
        context.registrar.provide(alpha, () => "A");
      },
    });

    await kernel.start();
    const snapshot = kernel.describe();
    const record = snapshot.plugins.find((plugin) => plugin.id === "provider");

    for (const key of record?.provides ?? []) {
      const entry = snapshot.services.find((service) => service.key === key);
      // 这条对得上，图里的「谁提供了什么」才不会和实际注册漂移。
      expect(entry?.providedBy).toBe("provider");
    }
    await kernel.dispose();
  });

  it("只有字符串：记录里没有 token 实例也没有 factory", async () => {
    const kernel = createKernel();
    kernel.use({
      id: "provider",
      version: "1.0.0",
      provides: [alpha],
      activate: (context) => {
        context.registrar.provide(alpha, () => "A");
      },
    });
    await kernel.start();

    const record = kernel.describe().plugins[0];
    expect(record.provides.every((value) => typeof value === "string")).toBe(true);
    expect(JSON.stringify(record)).not.toContain("function");
    await kernel.dispose();
  });
});
