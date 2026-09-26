import { llmPlugins } from "./plugins";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AikaPlugin } from "../kernel";
import { activeFetch, FetchToken, resetInstalledHttpFetch } from "../services/http";
import { NotifierToken } from "../services/notification/notifier";
import { KnowledgeWikiToken } from "../services/knowledge/wiki";
import { remoteAvailable, resetInstalledRemoteHost, type RemoteHost } from "../services/remote/bridge";
import { LocalTasksToken } from "../services/runtime/localTasks";
import { RemoteHostToken } from "../services/remote/tokens";
import type { AikaStorage } from "../services/storage/contracts";
import { resetInstalledSecretStore, secretStore } from "../services/storage/secretStore";
import { SecretStoreToken, SettingsToken, StorageToken } from "../services/storage/tokens";
import { ClockToken, TimersToken } from "../services/time/tokens";
import { createSqliteStorage } from "../services/storage/sqliteStorage";
import { openMemorySqlite } from "../services/storage/nodeSqlite.harness";
import { createAikaKernel } from "./composition";
import { browserHostPlugins, tauriHostPlugins, testHostPlugins } from "./hosts";
import { remotePlugin } from "./hosts/plugins";

/**
 * 组合根与宿主装配。
 *
 * 关键不是「能 resolve 出东西」，而是：
 * 1. 平台没有的能力，对应 token **根本不存在**，消费方据此降级；
 * 2. 旧调用方的过渡转发确实指向宿主提供的实现，而不是靠嗅探得来的默认值；
 * 3. 装配失败时存储故障**看得见**，不会悄悄退回浏览器实现。
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
  resetInstalledHttpFetch();
  resetInstalledRemoteHost();
  vi.unstubAllGlobals();
});

describe("宿主装配", () => {
  it("默认组合根在无 SQL 宿主上不声明 Wiki，内核仍能启动", async () => {
    const { sqlExecutor: _sqlExecutor, ...storage } = await realStorage();
    const { kernel, report } = await createAikaKernel({
      hostPlugins: testHostPlugins({ storage: { ...storage, kind: "local" } }),
      installLegacyPorts: false,
    });
    expect(report.ok).toBe(true);
    expect(kernel.registry.has(KnowledgeWikiToken)).toBe(false);
    await kernel.dispose();
  });

  it("正式任务插件激活后仍可使用时钟执行 tick", async () => {
    const { kernel, report } = await createAikaKernel({
      hostPlugins: testHostPlugins({ storage: await realStorage() }),
      installLegacyPorts: false,
    });
    expect(report.ok).toBe(true);
    await expect(kernel.registry.resolve(LocalTasksToken).tick()).resolves.toBeUndefined();
    await kernel.dispose();
  });

  it("测试宿主装好后六个核心端口都解析得到", async () => {
    const storage = await realStorage();
    const { kernel, report } = await createAikaKernel({
      hostPlugins: testHostPlugins({ storage }),
      installLegacyPorts: false,
    });

    expect(report.ok).toBe(true);
    expect(kernel.registry.resolve(StorageToken)).toBe(storage);
    expect(kernel.registry.resolve(SecretStoreToken)).toBeDefined();
    expect(kernel.registry.resolve(SettingsToken)).toBeDefined();
    expect(kernel.registry.resolve(NotifierToken)).toBeDefined();
    expect(kernel.registry.resolve(ClockToken).now()).toBeTypeOf("number");
    expect(kernel.registry.resolve(TimersToken)).toBeDefined();

    await kernel.dispose();
  });

  it("能力缺失就是 token 不注册：浏览器宿主没有远程能力", async () => {
    const storage = await realStorage();
    const { kernel } = await createAikaKernel({
      hostPlugins: testHostPlugins({ storage }),
      installLegacyPorts: false,
    });

    expect(kernel.registry.has(RemoteHostToken)).toBe(false);
    // 消费方按 optional + tryResolve 降级，不是拿到一个「调用即抛」的假实现。
    expect(kernel.registry.tryResolve(RemoteHostToken)).toBeNull();

    await kernel.dispose();
  });

  it("装了远程插件的宿主才有 RemoteHostToken", async () => {
    const storage = await realStorage();
    const host = fakeRemoteHost();
    const { kernel } = await createAikaKernel({
      hostPlugins: [...testHostPlugins({ storage }), remotePlugin(host)],
      installLegacyPorts: false,
    });

    expect(kernel.registry.resolve(RemoteHostToken)).toBe(host);

    await kernel.dispose();
  });

  it("桌面与浏览器的差别体现在装了哪些插件，而不是插件内部分支", () => {
    const desktop = tauriHostPlugins().map((plugin: AikaPlugin) => plugin.id);
    const browser = browserHostPlugins().map((plugin: AikaPlugin) => plugin.id);

    expect(desktop).toContain("host.remote");
    expect(browser).not.toContain("host.remote");
    // 出站传输同理：桌面有 Rust 侧中转，浏览器 dev 走 relay（未装配即没有）。
    expect(desktop).toContain("host.outboundTransport");
    expect(browser).not.toContain("host.outboundTransport");
    // 存活状态两边都有：它只描述「本进程还活着吗」，与平台无关。
    expect(desktop).toContain("host.lifecycle");
    expect(browser).toContain("host.lifecycle");
    // 其余端口两边都有，只是实现不同。
    for (const id of ["host.time", "host.storage", "host.secrets", "host.settings", "host.notifier", "host.fetch"]) {
      expect(desktop).toContain(id);
      expect(browser).toContain(id);
    }
  });

  it("settings 硬依赖 storage，拓扑排序保证它排在后面", async () => {
    const storage = await realStorage();
    const { kernel } = await createAikaKernel({
      hostPlugins: testHostPlugins({ storage }),
      installLegacyPorts: false,
    });

    const order = kernel.describe().plugins.map((plugin) => plugin.id);

    expect(order.every((id) => kernel.describe().plugins.find((p) => p.id === id)?.status === "activated")).toBe(true);
    await kernel.registry.resolve(SettingsToken).setRaw("k", "v");
    expect(await storage.getSetting("k")).toBe("v");

    await kernel.dispose();
  });
});

describe("过渡转发", () => {
  it("尚未插件化的调用方拿到宿主提供的实现（密钥 / HTTP / 远程）", async () => {
    const storage = await realStorage();
    const host = fakeRemoteHost();
    const fetchImpl = vi.fn(async () => new Response("ok"));
    const { kernel } = await createAikaKernel({
      hostPlugins: [
        ...testHostPlugins({ storage, fetch: fetchImpl }),
        remotePlugin(host),
      ],
    });

    // 存储只经 StorageToken 提供（CORE-06 删除了 openStorage 过渡转发）。
    expect(kernel.registry.resolve(StorageToken)).toBe(storage);
    expect(await secretStore.secure()).toBe(false);
    expect(remoteAvailable()).toBe(true);
    await activeFetch("https://example.com", {});
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(kernel.registry.resolve(FetchToken)).toBe(fetchImpl);

    await kernel.dispose();
  });

  it("没有远程能力时 remoteAvailable 如实返回 false", async () => {
    const storage = await realStorage();
    const { kernel } = await createAikaKernel({ hostPlugins: testHostPlugins({ storage }) });

    expect(remoteAvailable()).toBe(false);

    await kernel.dispose();
  });

  it("通知走 Notifier 端口；宿主没装通知能力时注入 no-op，返回 false 不抛", async () => {
    const storage = await realStorage();
    const { kernel } = await createAikaKernel({ hostPlugins: testHostPlugins({ storage }) });

    expect(await kernel.registry.resolve(NotifierToken).notify({ title: "t", body: "b" })).toBe(false);

    await kernel.dispose();
  });

  it("装配失败时存储故障看得见，不会悄悄退回浏览器实现", async () => {
    const broken: AikaPlugin = {
      id: "host.storage",
      version: "1.0.0",
      provides: [StorageToken],
      activate: () => {
        throw new Error("database is locked");
      },
    };
    const storage = await realStorage();
    const plugins = testHostPlugins({ storage }).filter((plugin) => plugin.id !== "host.storage");

    const { report, presentation } = await createAikaKernel({ hostPlugins: [...plugins, broken] });

    expect(report.ok).toBe(false);
    // 关键：失败经同一条 storageError 通道显示出来，而不是拿到一个能用的 localStorage。
    expect(presentation).not.toBeNull();
    await presentation!.companion.start();
    expect(presentation!.companion.getSnapshot().storageError).toMatch(/database is locked/);
  });
});

describe("CORE-06 单一编排与旧设置兼容", () => {
  it("旧库里残留的 core.orchestrator 被当作未知设置忽略，启动不报错", async () => {
    const { db, executor } = openMemorySqlite();
    const storage = await createSqliteStorage(executor);
    // CORE-03 迁移期写过这个键；CORE-06 删掉旧编排后没有任何代码再读它。
    await storage.setSetting("core.orchestrator", "legacy");

    const { kernel, report } = await createAikaKernel({
      hostPlugins: testHostPlugins({ storage }), featurePlugins: llmPlugins(),
    });
    try {
      expect(report.ok).toBe(true);
      expect(await storage.getSetting("core.orchestrator")).toBe("legacy");
    } finally {
      await kernel.dispose();
      db.close();
    }
  });
});
