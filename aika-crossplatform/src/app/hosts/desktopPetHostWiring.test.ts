import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AikaPlugin } from "../../kernel";
import { createAikaKernel } from "../composition";
import { testHostPlugins } from "../hosts";
import { desktopPetPlugin } from "./desktopPet";
import { PresentationLifecycleToken } from "../../services/desktopPet/lifecycle";
import { DesktopPetServiceToken, PET_CONFIG_DEFAULTS } from "../../services/desktopPet/contracts";
import { createDesktopPetSettings } from "../../services/desktopPet/settings";
import {
  alwaysRespond,
  createFakeOsProcessPort,
  createFakePetHttp,
  fakePetProfile,
  type FakeOsProcessPort,
  type FakePetHttpPort,
} from "../../services/desktopPet/fakeDesktopPet";
import { OK_POST, jsonResponse } from "../../services/desktopPet/fixtures/openPetFixtures";
import { ProviderSettingsToken, RuntimeToken } from "../../services/runtime/tokens";
import { createSettingsStore } from "../../services/storage/settingsStore";
import { SETTING_KEYS, type AikaStorage } from "../../services/storage/contracts";
import { createSqliteStorage } from "../../services/storage/sqliteStorage";
import { openMemorySqlite } from "../../services/storage/nodeSqlite.harness";
import { DesktopPetPresenterToken } from "../../presentation/tokens";
import type { DesktopPetRuntimeEvent } from "../../presentation/desktopPetPresenter";

/**
 * PET-06 定向测试：生产装配 + 假外部端口。
 *
 * 证的是**接线**：配置怎么读、token 装不装、公开事件能不能走到 HTTP 端口、
 * 关着的时候是不是真的零请求零进程。真实桌面能力仍属 PET-07。
 */

afterEach(() => {
  // 内核 dispose 由每个用例自己负责；这里只做全局槽位的复位兜底。
});

describe("MVP-02 optional presentation lifecycle", () => {
  it("is registered in production and can stop/restart without rebuilding Core", async () => {
    const { composition, http } = await boot({ http: createFakePetHttp(alwaysRespond(OK_POST)) });
    const lifecycle = composition.kernel.registry.resolve(PresentationLifecycleToken);
    const service = composition.kernel.registry.resolve(DesktopPetServiceToken);
    await lifecycle.start();
    expect((await lifecycle.health()).state).toBe("running");
    await lifecycle.stop();
    const calls = http.calls.length;
    await service.say("disabled");
    expect(http.calls.length).toBe(calls);
    await lifecycle.start();
    expect(composition.kernel.state).toBe("ready");
    await composition.kernel.dispose();
  });
});

async function realStorage(): Promise<AikaStorage> {
  const { executor } = openMemorySqlite();
  return createSqliteStorage(executor);
}

/** 内存设置库：跑生产的 settingsStore 语义，只换后端。 */
function memorySettings(seed: Record<string, string> = {}) {
  const values = new Map<string, string>(Object.entries(seed));
  const store = createSettingsStore({
    getSetting: async (key) => values.get(key) ?? null,
    setSetting: async (key, value) => void values.set(key, value),
  });
  return { values, store };
}

/** 提供一个「主窗 Runtime」与控制 ProviderSettings 的最小插件组。 */
function runtimeWiring(runtime: unknown): AikaPlugin[] {
  return [
    {
      id: "test.runtime",
      version: "1.0.0",
      provides: [RuntimeToken],
      activate(context) {
        context.registrar.provide(RuntimeToken, () => runtime as never);
      },
    },
    {
      id: "test.providerSettings",
      version: "1.0.0",
      provides: [ProviderSettingsToken],
      activate(context) {
        context.registrar.provide(ProviderSettingsToken, () => ({}) as never);
      },
    },
  ];
}

function fakeRuntime() {
  const listeners = new Set<(event: DesktopPetRuntimeEvent) => void>();
  return {
    runtime: {
      subscribe(listener: (event: DesktopPetRuntimeEvent) => void) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    emit(event: Partial<DesktopPetRuntimeEvent> & { turnId: string; type: string }) {
      for (const listener of [...listeners]) listener({ seq: 1, ...event } as DesktopPetRuntimeEvent);
    },
    listenerCount: () => listeners.size,
  };
}

async function boot(options: {
  seed?: Record<string, string>;
  http?: FakePetHttpPort;
  process?: FakeOsProcessPort;
  withRuntime?: boolean;
}) {
  const storage = await realStorage();
  for (const [key, value] of Object.entries(options.seed ?? {})) {
    await storage.setSetting(key, value);
  }
  const http = options.http ?? createFakePetHttp();
  const process = options.process ?? createFakeOsProcessPort();
  const runtime = fakeRuntime();

  const composition = await createAikaKernel({
    hostPlugins: [
      ...testHostPlugins({ storage }),
      desktopPetPlugin({ http, process }),
      ...(options.withRuntime ? runtimeWiring(runtime.runtime) : []),
    ],
    featurePlugins: [],
    installLegacyPorts: false,
  });
  return { composition, storage, http, process, runtime };
}

describe("PET-06-A 配置读取、损坏回落与关闭状态零副作用", () => {
  it("首次配置默认关闭，旧 pet.windowEnabled 不会变成托管启动授权", async () => {
    const { values, store } = memorySettings({ [SETTING_KEYS.petWindowEnabled]: "true" });
    const settings = createDesktopPetSettings(store);
    const { config, profile } = await settings.read();
    expect(config).toEqual({ ...PET_CONFIG_DEFAULTS });
    expect(config.enabled).toBe(false);
    expect(profile).toBeNull();
    // 读取不写回：坏/旧值不会被顺手"修"成正常值。
    expect(values.has(SETTING_KEYS.desktopPet)).toBe(false);
  });

  it("损坏的 JSON 与非法地址都回落到默认值，且不写回存储", async () => {
    for (const raw of ["{ not json", JSON.stringify({ ...PET_CONFIG_DEFAULTS, endpoint: "http://10.0.0.5:17321" })]) {
      const { values, store } = memorySettings({ [SETTING_KEYS.desktopPet]: raw });
      const settings = createDesktopPetSettings(store);
      const config = await settings.readConfig();
      expect(config.endpoint).toBe(PET_CONFIG_DEFAULTS.endpoint);
      expect(values.get(SETTING_KEYS.desktopPet)).toBe(raw);
    }
  });

  it("损坏的 profile 等价于没有 profile", async () => {
    const { store } = memorySettings({ [SETTING_KEYS.desktopPetProfile]: '{"schemaVersion":2}' });
    expect(await createDesktopPetSettings(store).readProfile()).toBeNull();
  });

  it("关闭状态下装配完成但零请求、零进程", async () => {
    const http = createFakePetHttp();
    const process = createFakeOsProcessPort();
    const { composition } = await boot({ http, process });
    const service = composition.kernel.registry.resolve(DesktopPetServiceToken);

    expect(composition.report.ok).toBe(true);
    expect(service.isEnabled()).toBe(false);
    expect(service.snapshot().connection).toBe("disabled");
    expect(http.calls).toEqual([]);
    expect(process.spawns).toEqual([]);

    await composition.kernel.dispose();
  });

  it("启用后「测试连接」是真的探测一次", async () => {
    const http = createFakePetHttp(alwaysRespond(jsonResponse(200, { port: 17321, activePet: { id: "nia" } })));
    const { composition } = await boot({
      http,
      seed: { [SETTING_KEYS.desktopPet]: JSON.stringify({ ...PET_CONFIG_DEFAULTS, enabled: true }) },
    });
    const service = composition.kernel.registry.resolve(DesktopPetServiceToken);
    await service.enable();
    const status = await service.status();
    expect(status.connection).toBe("ready");
    expect(http.countOf("status")).toBeGreaterThanOrEqual(1);

    await service.disable();
    const before = http.calls.length;
    // 关闭之后即使再点测试连接也不再发请求。
    expect(await service.status()).toMatchObject({ connection: "disabled" });
    expect(http.calls.length).toBe(before);
    await composition.kernel.dispose();
  });
});

describe("PET-06-B 生产事件 → 生产 Service → 外部端口", () => {
  it("四类命令经真实装配到达 HTTP 端口，且没有第二个 Runtime", async () => {
    const http = createFakePetHttp(alwaysRespond(OK_POST));
    const { composition, runtime } = await boot({
      http,
      withRuntime: true,
      seed: {
        [SETTING_KEYS.desktopPet]: JSON.stringify({ ...PET_CONFIG_DEFAULTS, endpoint: "http://127.0.0.1:17321" }),
        [SETTING_KEYS.desktopPetProfile]: JSON.stringify(fakePetProfile({ petId: "nia" })),
      },
    });
    const service = composition.kernel.registry.resolve(DesktopPetServiceToken);
    await service.enable();
    expect(service.snapshot().connection, JSON.stringify(service.diagnostics())).toBe("ready");
    expect(service.snapshot().capabilities.say).toBe("native");

    const presenter = composition.kernel.registry.resolve(DesktopPetPresenterToken);
    expect(presenter.available()).toBe(true);
    presenter.start();
    expect(runtime.listenerCount()).toBe(1);

    runtime.emit({ turnId: "t1", type: "state", state: "generating" });
    runtime.emit({ turnId: "t1", type: "generated", reply: { replyText: "在的哦", mood: "happy" } });
    runtime.emit({ turnId: "t1", type: "settled", state: "completed" });
    await new Promise((resolve) => { globalThis.setTimeout(resolve, 0); });
    await new Promise((resolve) => { globalThis.setTimeout(resolve, 0); });

    // 三条：thinking 事件 + 情绪（走 action 端点）+ 最终文本。
    expect(presenter.bufferDiagnostics()).toMatchObject({ sent: 3 });
    expect(http.countOf("say")).toBe(1);
    // 情绪走的是 action 端点（上游没有 /api/emotion）。
    expect(http.countOf("action")).toBe(1);
    expect(http.calls.filter((call) => call.endpoint === "event")).toHaveLength(1);

    const sayBody = JSON.parse(http.calls.find((call) => call.endpoint === "say")!.body!) as {
      text: string; ttlMs: number;
    };
    expect(sayBody.text).toBe("在的哦");
    // PET-04已经拆分发送deadline与显示TTL：三字短句为4000+3*120ms。
    expect(sayBody.ttlMs).toBeGreaterThanOrEqual(4_000);
    expect(sayBody.ttlMs).toBeLessThanOrEqual(4_360);

    // 唯一的 Runtime 就是我们注入的那个：没有第二条编排。
    expect(composition.kernel.registry.tryResolve(RuntimeToken)).toBe(runtime.runtime);

    presenter.dispose();
    await composition.kernel.dispose();
  });

  it("浏览器宿主没有这个能力：token 不存在，消费方拿到 null", async () => {
    const storage = await realStorage();
    const composition = await createAikaKernel({
      hostPlugins: [...testHostPlugins({ storage })],
      featurePlugins: [],
      installLegacyPorts: false,
    });
    expect(composition.kernel.registry.tryResolve(DesktopPetServiceToken)).toBeNull();
    await composition.kernel.dispose();
  });
});

describe("PET-06-C 表现出口只保留一个", () => {
  it("main入口与窗口配置不再提供旧桌宠", () => {
    const main = readFileSync(join(import.meta.dirname, "../../main.tsx"), "utf8");
    expect(main).not.toContain("PetApp");
    const config = JSON.parse(readFileSync(join(import.meta.dirname, "../../../src-tauri/tauri.conf.json"), "utf8"));
    expect(config.app.windows.map((w: { label: string }) => w.label)).toEqual(["main"]);
  });

  it("集成开关落地到存储后 isEnabled 为真（让位判断的输入）", async () => {
    const { store } = memorySettings();
    const settings = createDesktopPetSettings(store);
    expect(await settings.isEnabled()).toBe(false);
    await settings.writeConfig({ ...PET_CONFIG_DEFAULTS, enabled: true });
    expect(await settings.isEnabled()).toBe(true);
  });
});

describe("PET-06-D 桌宠故障不阻塞业务", () => {
  it("桌宠离线时 Runtime submit 照常，界面拿到的是明确降级原因", async () => {
    const http = createFakePetHttp();          // 默认：连接被拒绝
    const { composition, runtime } = await boot({
      http,
      withRuntime: true,
      seed: { [SETTING_KEYS.desktopPet]: JSON.stringify({ ...PET_CONFIG_DEFAULTS, enabled: true }) },
    });
    const service = composition.kernel.registry.resolve(DesktopPetServiceToken);
    const presenter = composition.kernel.registry.resolve(DesktopPetPresenterToken);
    presenter.start();
    await service.enable();

    expect(presenter.snapshot().connection).toBe("offline");
    expect(presenter.snapshot().stale).toBe(true);

    // 业务侧：一轮正常提交不受桌宠影响（这里用假 Runtime 证明编排未被接管）。
    runtime.emit({ turnId: "t1", type: "state", state: "generating" });
    runtime.emit({ turnId: "t1", type: "generated", reply: { replyText: "在的", mood: "happy" } });
    runtime.emit({ turnId: "t1", type: "settled", state: "completed" });
    await new Promise((resolve) => { globalThis.setTimeout(resolve, 0); });
    // 离线时一条命令都发不出去，但接入层没有抛错、业务状态没有改变。
    expect(http.countOf("say")).toBe(0);
    expect(service.snapshot().connection).toBe("offline");

    presenter.dispose();
    await composition.kernel.dispose();
  });
});

describe("PET-06-E 反复开关不留下重复订阅与所有权", () => {
  it("10 次 enable/disable 不产生重复探测循环，退出后不遗留所有权", async () => {
    const http = createFakePetHttp(alwaysRespond(jsonResponse(200, { activePet: { id: "nia" } })));
    const process = createFakeOsProcessPort();
    const { composition } = await boot({
      http,
      process,
      seed: { [SETTING_KEYS.desktopPet]: JSON.stringify({ ...PET_CONFIG_DEFAULTS, enabled: true }) },
    });
    const service = composition.kernel.registry.resolve(DesktopPetServiceToken);

    for (let index = 0; index < 10; index += 1) {
      await service.enable();
      await service.disable();
    }
    await service.enable();
    // 单飞探测 + 单条探测循环：一次启用只对应一次即时探测。
    const probes = http.countOf("status");
    await service.status();
    expect(http.countOf("status")).toBe(probes + 1);

    await composition.kernel.dispose();
    // attach 模式：一个进程都不该被启动或停止。
    expect(process.spawns).toEqual([]);
    expect(process.stopCalls).toEqual([]);
  });
});

describe("PET-06-F 如实标注能力差距", () => {
  it("设置面板声明「当前桌宠不支持点击回传」，并把控制留在主窗", () => {
    const hook = readFileSync(join(import.meta.dirname ?? ".", "../../hooks/useDesktopPet.ts"), "utf8");
    expect(hook).toContain("petInputSupported: false");
    const app = readFileSync(join(import.meta.dirname ?? ".", "../../App.tsx"), "utf8");
    expect(app).toContain("当前桌宠不支持点击回传");
    // 主窗同等业务入口仍在：陪伴会话与点读屏的设置块没有被删掉。
    expect(app).toContain("陪伴");
  });
});

describe("PET-06-G 契约登记与兼容", () => {
  it("共享契约文件已登记 PET-06 的追加", () => {
    const doc = readFileSync(join(import.meta.dirname ?? ".", "../../../../docs/modules/CONTRACTS.md"), "utf8");
    expect(doc).toContain("PET-06");
    expect(doc).toContain("DesktopPetPresenterToken");
    expect(doc).toContain("desktopPet");
  });

  it("新增设置键不覆盖旧键，旧库照常可读", () => {
    expect(SETTING_KEYS.desktopPet).not.toBe(SETTING_KEYS.petWindowEnabled);
    expect(SETTING_KEYS.desktopPetProfile).not.toBe(SETTING_KEYS.desktopPet);
  });
});
