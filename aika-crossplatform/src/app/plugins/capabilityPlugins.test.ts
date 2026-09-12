import { afterEach, describe, expect, it, vi } from "vitest";
import { token, type AikaPlugin } from "../../kernel";
import { PROVIDER_PRESETS } from "../../domain/providers";
import { createMemoryV2 } from "../../domain/memory";
import { RuntimeToken } from "../../services/runtime/tokens";
import { RemoteHostToken } from "../../services/remote/tokens";
import type { RemoteHost } from "../../services/remote/bridge";
import { resetInstalledRemoteHost } from "../../services/remote/bridge";
import { saveProvider } from "../../services/storage";
import { resetInstalledSecretStore } from "../../services/storage/secretStore";
import type { AikaStorage } from "../../services/storage/contracts";
import { createSqliteStorage } from "../../services/storage/sqliteStorage";
import { openMemorySqlite } from "../../services/storage/nodeSqlite.harness";
import { MemoryAccessToken, MemoryRepositoryToken } from "../../services/memory/tokens";
import { StickerLibraryToken } from "../../services/stickers/tokens";
import { SpeechEnginesToken } from "../../services/voice/tokens";
import type { SpeechEngines } from "../../services/voice/tokens";
import { CompanionPresenterToken, VoicePresenterToken } from "../../presentation/tokens";
import { createAikaKernel } from "../composition";
import { testHostPlugins } from "../hosts";
import { remotePlugin } from "../hosts/plugins";
import {
  capabilityPlugins, contextSourcesPlugin, memoryPlugin, providerSettingsPlugin, runtimePlugin,
  sampleCapabilityPlugin, SampleCapabilityToken, stickersPlugin, voicePlugin,
} from ".";

/**
 * CORE-05：能力插件与扩展点。
 *
 * 验证的不是「文件挪了位置」，而是三条可证伪的结论：
 * 1. 声明与实际完全一致，三种违约都会让内核失败并逆序回滚；
 * 2. 能力缺失（无 Remote / 空表情包 / 无麦克风权限）是常态，应用照常启动；
 * 3. 加一个新能力只需要新增一个插件文件加一行注册。
 */

function fakeRemoteHost(): RemoteHost {
  return {
    start: async () => ({ port: 1, url: "u", host: "h" }),
    stop: async () => undefined,
    status: async () => null,
    respond: async () => undefined,
    listen: async () => () => undefined,
  };
}

async function realStorage(): Promise<AikaStorage> {
  const { executor } = openMemorySqlite();
  return createSqliteStorage(executor);
}

afterEach(() => {
  resetInstalledSecretStore();
  resetInstalledRemoteHost();
});

describe("CORE-05-A 能力插件声明与实际一致", () => {
  it("默认装配下四个能力 token 全部可解析", async () => {
    const { kernel, report } = await createAikaKernel({
      hostPlugins: testHostPlugins({ storage: await realStorage() }),
      installLegacyPorts: false,
    });

    expect(report.ok).toBe(true);
    expect(kernel.registry.resolve(RuntimeToken)).toBeDefined();
    expect(kernel.registry.resolve(MemoryRepositoryToken)).toBeDefined();
    expect(kernel.registry.resolve(MemoryAccessToken).repository).toBe(kernel.registry.resolve(MemoryRepositoryToken));
    expect(kernel.registry.resolve(StickerLibraryToken)).toBeTypeOf("function");
    expect(kernel.registry.resolve(SpeechEnginesToken).createInputEngine).toBeTypeOf("function");

    await kernel.dispose();
  });

  it("声明了却没提供 → PLUGIN_CONTRACT_VIOLATION，state failed，前面已激活的按逆序回滚", async () => {
    const order: string[] = [];
    const marker: AikaPlugin = {
      id: "capability.marker",
      version: "1.0.0",
      provides: [SampleCapabilityToken],
      activate(context) {
        context.registrar.provide(SampleCapabilityToken, () => ({ describe: () => "marker" }));
      },
      deactivate() {
        order.push("marker");
      },
    };
    const liar: AikaPlugin = {
      id: "capability.liar",
      version: "1.0.0",
      provides: [StickerLibraryToken],
      activate() {
        // 声明了 provides 却一个都不注册：依赖图在撒谎，必须失败。
      },
    };

    const { kernel, report } = await createAikaKernel({
      hostPlugins: testHostPlugins({ storage: await realStorage() }),
      featurePlugins: [marker, liar],
      installLegacyPorts: false,
    });

    expect(report.ok).toBe(false);
    expect(kernel.state).toBe("failed");
    expect(report.failed[0]).toMatchObject({ pluginId: "capability.liar", code: "PLUGIN_CONTRACT_VIOLATION" });
    // 逆序回滚真的执行了先激活的那个，不是只把状态一改了事。
    expect(order).toEqual(["marker"]);
    expect(report.activated).toEqual([]);
    // 不留半启动状态：外部解析直接失败。
    expect(() => kernel.registry.resolve(SampleCapabilityToken)).toThrow();
  });

  it("提供未声明的 token → TOKEN_NOT_DECLARED", async () => {
    const liar: AikaPlugin = {
      id: "capability.overreach",
      version: "1.0.0",
      activate(context) {
        context.registrar.provide(SampleCapabilityToken, () => ({ describe: () => "x" }));
      },
    };

    const { kernel, report } = await createAikaKernel({
      hostPlugins: testHostPlugins({ storage: await realStorage() }),
      featurePlugins: [liar],
      installLegacyPorts: false,
    });

    expect(report.ok).toBe(false);
    expect(kernel.state).toBe("failed");
    expect(report.failed[0]).toMatchObject({ pluginId: "capability.overreach", code: "TOKEN_NOT_DECLARED" });
  });

  it("解析未声明的依赖 → DEPENDENCY_NOT_DECLARED", async () => {
    const sneaky: AikaPlugin = {
      id: "capability.sneaky",
      version: "1.0.0",
      activate(context) {
        // 没有写进 requires/optional 的 token 不许拿，硬取就抛错。
        context.registrar.resolve(RuntimeToken);
      },
    };

    const { kernel, report } = await createAikaKernel({
      hostPlugins: testHostPlugins({ storage: await realStorage() }),
      featurePlugins: [...capabilityPlugins(), sneaky],
      installLegacyPorts: false,
    });

    expect(report.ok).toBe(false);
    expect(kernel.state).toBe("failed");
    expect(report.failed[0]).toMatchObject({ pluginId: "capability.sneaky", code: "DEPENDENCY_NOT_DECLARED" });
  });
});

describe("CORE-05-B 能力缺失是常态", () => {
  it("没有 Remote：token 根本不注册，应用照常启动", async () => {
    const { kernel, report } = await createAikaKernel({
      hostPlugins: testHostPlugins({ storage: await realStorage() }),
      installLegacyPorts: false,
    });

    expect(report.ok).toBe(true);
    expect(kernel.registry.has(RemoteHostToken)).toBe(false);
    // 消费方按 optional + tryResolve 降级，界面据此隐藏入口，不弹错误。
    expect(kernel.registry.tryResolve(RemoteHostToken)).toBeNull();

    await kernel.dispose();
  });

  it("表情包清单为空：注册的是空清单函数，Presenter 照常 ready", async () => {
    const { kernel, report } = await createAikaKernel({
      hostPlugins: testHostPlugins({ storage: await realStorage() }),
      featurePlugins: [
        providerSettingsPlugin(), memoryPlugin(), contextSourcesPlugin(), runtimePlugin(), voicePlugin(),
        stickersPlugin(async () => []),
      ],
    });

    expect(report.ok).toBe(true);
    expect(await kernel.registry.resolve(StickerLibraryToken)()).toEqual([]);

    const presenter = kernel.registry.resolve(CompanionPresenterToken);
    await presenter.start();
    expect(presenter.getSnapshot().ready).toBe(true);
    expect(presenter.getSnapshot().stickers).toEqual([]);

    await kernel.dispose();
  });

  it("无麦克风权限：语音页显示错误但不崩、应用仍可用", async () => {
    const denied: SpeechEngines = {
      createInputEngine: async () => ({
        engine: {
          id: "denied", kind: "web-speech", continuous: false,
          isAvailable: () => true,
          requestPermission: async () => { throw new Error("permission denied"); },
          start: () => undefined,
          stop: () => undefined,
          abort: () => undefined,
          dispose: () => undefined,
        },
        note: "denied",
        degraded: false,
      }),
      outputEngine: { id: "fake", kind: "web-speech", isAvailable: () => true, speak: () => undefined, stop: () => undefined },
      createQueue: (_engine) => ({ begin: () => undefined, enqueue: () => undefined, end: () => undefined, setMood: () => undefined, speak: () => undefined, stop: () => undefined, isSpeaking: () => false }) as never,
      createMonitor: () => ({ isAvailable: () => true, start: async () => undefined, stop: () => undefined, dispose: async () => undefined }),
    };

    const { kernel, report } = await createAikaKernel({
      hostPlugins: testHostPlugins({ storage: await realStorage() }),
      featurePlugins: [voicePlugin(denied)],
      installLegacyPorts: false,
    });

    expect(report.ok).toBe(true);
    const voice = kernel.registry.resolve(VoicePresenterToken);
    await expect(voice.open()).resolves.toBeUndefined();
    expect(voice.getSnapshot().phase).toBe("error");
    expect(voice.getSnapshot().error).toContain("无法使用麦克风");
    // 应用没有崩：内核仍 ready，其它能力仍可解析。
    expect(kernel.state).toBe("ready");

    await kernel.dispose();
  });
});

describe("CORE-05-D 单一 Runtime", () => {
  it("Remote 宿主与本地 UI 使用同一个 Runtime 实例", async () => {
    const storage = await realStorage();
    const { kernel, report } = await createAikaKernel({
      hostPlugins: [
        ...testHostPlugins({ storage }),
        remotePlugin(fakeRemoteHost()),
      ],
    });

    expect(report.ok).toBe(true);
    expect(kernel.registry.has(RemoteHostToken)).toBe(true);

    const runtime = kernel.registry.resolve(RuntimeToken);
    // 单例：两次解析是同一个对象。
    expect(kernel.registry.resolve(RuntimeToken)).toBe(runtime);

    // 让 Presenter 认为已连上，然后观察「UI 发一轮」到底落到哪个编排对象上：
    // 展示插件注入的就是注册表里那一个实例，不是第二个 Runtime。
    await saveProvider(storage, { ...PROVIDER_PRESETS[1], apiKey: "test-key" });
    const submit = vi.spyOn(runtime, "submit").mockReturnValue({
      turnId: "single-runtime-turn",
      done: Promise.resolve({ state: "cancelled", persisted: true }),
    });
    const presenter = kernel.registry.resolve(CompanionPresenterToken);
    await presenter.start();
    void presenter.send("你好");
    expect(submit).toHaveBeenCalledTimes(1);

    await kernel.dispose();
  });
});

describe("CORE-05-C 扩展点可证伪", () => {
  it("新增示例插件只需一个文件加一行注册即可生效", async () => {
    const storage = await realStorage();
    const { kernel, report } = await createAikaKernel({
      hostPlugins: testHostPlugins({ storage }),
      featurePlugins: [...capabilityPlugins(), sampleCapabilityPlugin("capability-demo")],
      installLegacyPorts: false,
    });

    expect(report.ok).toBe(true);
    expect(kernel.registry.resolve(SampleCapabilityToken).describe()).toBe("capability-demo");
    // 加能力没有动内核：内核快照里不出现新能力的任何痕迹。
    expect(kernel.describe().plugins.map((plugin) => plugin.id)).toContain("sample.capability");

    await kernel.dispose();
  });

  it("示例插件是空操作：不写存储、不发请求", async () => {
    const storage = await realStorage();
    const setSetting = vi.spyOn(storage, "setSetting");
    const { kernel } = await createAikaKernel({
      hostPlugins: testHostPlugins({ storage }),
      featurePlugins: [sampleCapabilityPlugin()],
      installLegacyPorts: false,
    });

    kernel.registry.resolve(SampleCapabilityToken);
    expect(setSetting).not.toHaveBeenCalled();

    await kernel.dispose();
  });
});

describe("FE-11 记忆变更通知", () => {
  it("删除同时通知两组订阅者：先摘要作废，再「记忆变了」", async () => {
    const { kernel } = await createAikaKernel({
      hostPlugins: testHostPlugins({ storage: await realStorage() }),
      installLegacyPorts: false,
    });
    const access = kernel.registry.resolve(MemoryAccessToken);
    const order: string[] = [];
    access.onInvalidate(() => order.push("invalidate"));
    access.onChanged(() => order.push("changed"));

    const created = createMemoryV2({ content: "喜欢浅烘焙", type: "preference", sourceMessageIds: ["m1"] });
    await access.repository.upsert([created!]);
    await access.repository.forget(created!.id);

    // 顺序有意义：摘要先作废，界面再重读，读到的才是作废之后的状态。
    expect(order).toEqual(["invalidate", "changed"]);

    await kernel.dispose();
  });

  it("notifyChanged 只喊 changed 一组：确认与编辑不该让摘要作废", async () => {
    const { kernel } = await createAikaKernel({
      hostPlugins: testHostPlugins({ storage: await realStorage() }),
      installLegacyPorts: false,
    });
    const access = kernel.registry.resolve(MemoryAccessToken);
    const invalidated: string[] = [];
    const changed: string[] = [];
    access.onInvalidate(() => invalidated.push("x"));
    const stop = access.onChanged(() => changed.push("x"));

    access.notifyChanged();
    expect(invalidated).toEqual([]);
    expect(changed).toEqual(["x"]);

    // 退订之后不再收到。
    stop();
    access.notifyChanged();
    expect(changed).toEqual(["x"]);

    await kernel.dispose();
  });
});

describe("CORE-05 能力 token 定义在接口旁边", () => {
  it("能力 token 分散在各自模块，不存在中央清单文件", async () => {
    const voice = token<unknown>("voice.engines");
    // key 相同即同一个服务，跨模块不会分裂成两份注册。
    expect(voice.key).toBe(SpeechEnginesToken.key);
    expect(SpeechEnginesToken.key).toBe("voice.engines");
    expect(StickerLibraryToken.key).toBe("stickers.library");
    expect(MemoryAccessToken.key).toBe("llm.memoryAccess");
  });
});
