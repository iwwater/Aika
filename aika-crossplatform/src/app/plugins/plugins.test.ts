import { describe, expect, it, vi } from "vitest";
import { isKernelError, type PluginContext } from "../../kernel";
import { ContextSourcesToken } from "../../services/context/tokens";
import { MemoryRepositoryToken } from "../../services/memory/tokens";
import { ProviderSettingsToken, ProviderToken, RuntimeToken } from "../../services/runtime/tokens";
import type { AikaStorage } from "../../services/storage/contracts";
import { openMemorySqlite } from "../../services/storage/nodeSqlite.harness";
import { createSqliteStorage } from "../../services/storage/sqliteStorage";
import { StorageToken } from "../../services/storage/tokens";
import { createAikaKernel } from "../composition";
import { testHostPlugins } from "../hosts";
import { llmPlugins, memoryPlugin, noMemoryPlugin, providerSettingsPlugin, runtimePlugin } from ".";

/**
 * LLM 能力插件的装配。
 *
 * 重点在两件事：
 * 1. Runtime 终于有了生产装配路径——在此之前 createCompanionRuntime 只有测试在用；
 * 2. 「有没有记忆能力」是装配期的选择，不是插件内部的 if。内核会核对 provides
 *    声明与实际注册是否一致，写不出那种藏起来的分支。
 */

async function realStorage(): Promise<AikaStorage> {
  const { executor } = openMemorySqlite();
  return createSqliteStorage(executor);
}

/** 没有 memoryV2 端口的存储：老实现与测试 fake 就是这样。 */
function storageWithoutMemoryV2(base: AikaStorage): AikaStorage {
  const { memoryV2: _ignored, ...rest } = base;
  return rest as AikaStorage;
}

async function bootWith(storage: AikaStorage, feature = llmPlugins()) {
  return createAikaKernel({
    hostPlugins: testHostPlugins({ storage }),
    featurePlugins: feature,
    installLegacyPorts: false,
  });
}

describe("LLM 能力插件装配", () => {
  it("Runtime 成为注册表里的服务，且拿到的是同一个实例", async () => {
    const { kernel, report } = await bootWith(await realStorage());

    expect(report.ok).toBe(true);
    const runtime = kernel.registry.resolve(RuntimeToken);
    expect(runtime).toBe(kernel.registry.resolve(RuntimeToken));
    expect(typeof runtime.submit).toBe("function");
    expect(kernel.registry.resolve(ProviderToken)).toBeDefined();

    await kernel.dispose();
  });

  it("Runtime 是惰性的：没人 resolve 就不构造", async () => {
    const { kernel } = await bootWith(await realStorage());

    const before = kernel.describe().services.find((entry) => entry.key === "llm.runtime");
    expect(before?.instantiated).toBe(false);

    kernel.registry.resolve(RuntimeToken);
    const after = kernel.describe().services.find((entry) => entry.key === "llm.runtime");
    expect(after?.instantiated).toBe(true);

    await kernel.dispose();
  });

  it("内核释放时顺带把在途轮次收干净", async () => {
    const storage = await realStorage();
    const { kernel } = await bootWith(storage);
    const runtime = kernel.registry.resolve(RuntimeToken);
    const dispose = vi.spyOn(runtime, "dispose");

    await kernel.dispose();

    expect(dispose).toHaveBeenCalledOnce();
  });

  it("有 memoryV2 就注册仓储与记忆上下文源", async () => {
    const { kernel } = await bootWith(await realStorage());

    expect(kernel.registry.has(MemoryRepositoryToken)).toBe(true);
    expect(kernel.registry.resolve(ContextSourcesToken)).toHaveLength(1);

    await kernel.dispose();
  });

  it("没有记忆能力的宿主：仓储 token 根本不注册，上下文源为空", async () => {
    const storage = storageWithoutMemoryV2(await realStorage());
    const { kernel, report } = await bootWith(storage, [
      providerSettingsPlugin(), noMemoryPlugin(), runtimePlugin(),
    ]);

    expect(report.ok).toBe(true);
    // 拿到的是 null，不是一个「能调但永远为空」的假仓储。
    expect(kernel.registry.tryResolve(MemoryRepositoryToken)).toBeNull();
    expect(kernel.registry.resolve(ContextSourcesToken)).toEqual([]);
    // Runtime 照样能装配起来：没有记忆不等于不能对话。
    expect(kernel.registry.resolve(RuntimeToken)).toBeDefined();

    await kernel.dispose();
  });

  it("装错插件时装配明明白白地失败，不悄悄降级", async () => {
    const storage = storageWithoutMemoryV2(await realStorage());

    const { report } = await bootWith(storage, [
      providerSettingsPlugin(), memoryPlugin(), runtimePlugin(),
    ]);

    expect(report.ok).toBe(false);
    expect(report.failed[0].pluginId).toBe("llm.memory");
    expect(report.failed[0].message).toMatch(/noMemoryPlugin/);
  });

  it("Runtime 硬依赖存储与上下文源，缺一个就在激活前失败", async () => {
    const storage = await realStorage();

    const { report } = await createAikaKernel({
      hostPlugins: testHostPlugins({ storage }),
      // 少装 memory：ContextSourcesToken 没人提供。
      featurePlugins: [providerSettingsPlugin(), runtimePlugin()],
      installLegacyPorts: false,
    });

    expect(report.ok).toBe(false);
    expect(report.failed[0].code).toBe("PLUGIN_DEPENDENCY_MISSING");
    expect(report.failed[0].pluginId).toBe("llm.runtime");
  });

  it("Provider 设置是可写服务：改了之后 Runtime 侧读到新值", async () => {
    const { kernel } = await bootWith(await realStorage());
    const settings = kernel.registry.resolve(ProviderSettingsToken);

    const next = { ...settings.get(), model: "qwen-max" };
    settings.set(next);

    expect(kernel.registry.resolve(ProviderSettingsToken).get().model).toBe("qwen-max");

    await kernel.dispose();
  });

  it("memory 的两个变体共用 id：装配期就拦下，装不成两个都在", async () => {
    const storage = await realStorage();

    // 它们是互斥的替代品，不是两个能力，所以刻意共用 id。
    await expect(createAikaKernel({
      hostPlugins: testHostPlugins({ storage }),
      featurePlugins: [providerSettingsPlugin(), memoryPlugin(), noMemoryPlugin(), runtimePlugin()],
      installLegacyPorts: false,
    })).rejects.toSatisfy((error: unknown) => isKernelError(error, "PLUGIN_DUPLICATE_ID"));
  });

  it("不同插件抢同一个 token，在激活任何插件之前失败", async () => {
    const storage = await realStorage();
    const squatter = {
      id: "squatter",
      version: "1.0.0",
      provides: [ContextSourcesToken],
      activate: (context: PluginContext) => context.registrar.provide(ContextSourcesToken, () => []),
    };

    const { report } = await createAikaKernel({
      hostPlugins: testHostPlugins({ storage }),
      featurePlugins: [providerSettingsPlugin(), memoryPlugin(), squatter, runtimePlugin()],
      installLegacyPorts: false,
    });

    expect(report.ok).toBe(false);
    expect(report.failed[0].code).toBe("PLUGIN_PROVIDER_CONFLICT");
    // 一个插件都没激活，现场是干净的。
    expect(report.activated).toEqual([]);
  });

  it("STORAGE 依赖顺序正确：memory 与 runtime 都排在 storage 之后", async () => {
    const { kernel } = await bootWith(await realStorage());

    const activated = kernel.describe().plugins
      .filter((plugin) => plugin.status === "activated")
      .map((plugin) => plugin.id);

    expect(activated.indexOf("host.storage")).toBeLessThan(activated.indexOf("llm.memory"));
    expect(activated.indexOf("llm.memory")).toBeLessThan(activated.indexOf("llm.runtime"));
    expect(kernel.registry.resolve(StorageToken)).toBeDefined();

    await kernel.dispose();
  });
});
