import type { AikaPlugin } from "../../kernel";
import { createBrowserFetch, type HttpFetch } from "../../services/http";
import { createTauriFetch } from "../../services/http/tauriFetch";
import {
  createDesktopNotifier, createNoopNotifier, type Notifier,
} from "../../services/notification/notifier";
import { createTauriRemoteHost } from "../../services/remote/bridge";
import type { AikaStorage } from "../../services/storage/contracts";
import {
  createDesktopSecretStore, createInsecureSecretStore, type SecretStore,
} from "../../services/storage/secretStore";
import { openBrowserStorage, openDesktopStorage } from "../../services/storage";
import type { Clock, Timers } from "../../services/time/tokens";
import { createSystemClock, createSystemTimers } from "../../services/time/systemTime";
import { isTauriHost } from "./detect";
import {
  fetchPlugin, notifierPlugin, remotePlugin, secretsPlugin, settingsPlugin,
  storagePlugin, timePlugin,
} from "./plugins";

/**
 * 宿主插件集合。
 *
 * 「这个平台有什么本事」不是一张总表，而是「装了哪几个插件」。平台没有某项
 * 能力，对应的 token 就根本不注册——消费方 tryResolve 拿到 null 自行降级。
 */

export interface HostOptions {
  clock?: Clock;
  timers?: Timers;
  onSettingsFallback?: (key: string, reason: string) => void;
}

function baseHost(
  storage: () => Promise<AikaStorage>,
  secrets: SecretStore,
  notifier: Notifier,
  fetchImpl: HttpFetch,
  options: HostOptions,
): AikaPlugin[] {
  return [
    timePlugin(options.clock ?? createSystemClock(), options.timers ?? createSystemTimers()),
    storagePlugin(storage),
    secretsPlugin(secrets),
    settingsPlugin(options.onSettingsFallback),
    notifierPlugin(notifier),
    fetchPlugin(fetchImpl),
  ];
}

/** 浏览器 dev：localStorage + 明文密钥 + 没有通知 + 原生 fetch + 没有远程能力。 */
export function browserHostPlugins(options: HostOptions = {}): AikaPlugin[] {
  return baseHost(
    async () => openBrowserStorage(),
    createInsecureSecretStore(),
    createNoopNotifier(),
    createBrowserFetch(),
    options,
  );
}

/** Tauri 桌面：SQLite + DPAPI + 系统通知 + plugin-http + 远程能力。 */
export function tauriHostPlugins(options: HostOptions = {}): AikaPlugin[] {
  const secrets = createDesktopSecretStore({
    invoke: async (command, args) => {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke(command, args) as never;
    },
  });
  const notifier = createDesktopNotifier({
    isPermissionGranted: async () => {
      const api = await import("@tauri-apps/plugin-notification");
      return api.isPermissionGranted();
    },
    requestPermission: async () => {
      const api = await import("@tauri-apps/plugin-notification");
      return api.requestPermission();
    },
    sendNotification: (input) => {
      void import("@tauri-apps/plugin-notification").then((api) => api.sendNotification(input));
    },
  });

  return [
    ...baseHost(() => openDesktopStorage(secrets), secrets, notifier, createTauriFetch(), options),
    remotePlugin(createTauriRemoteHost()),
  ];
}

export interface TestHostOptions extends HostOptions {
  /**
   * 测试宿主不自带存储实现。
   *
   * 「为了凑一个测试宿主而再写一个 AikaStorage」正是端口一致性计划里禁止的事：
   * 那个实现没人用，却会稀释用例包。所以这里要求调用方把被测实现交进来。
   */
  storage: AikaStorage;
  secrets?: SecretStore;
  notifier?: Notifier;
  fetch?: HttpFetch;
}

export function testHostPlugins(options: TestHostOptions): AikaPlugin[] {
  return baseHost(
    async () => options.storage,
    options.secrets ?? createInsecureSecretStore(memoryBackend()),
    options.notifier ?? createNoopNotifier(),
    options.fetch ?? (async () => {
      throw new Error("test host has no fetch; inject one if the test needs it");
    }),
    options,
  );
}

function memoryBackend() {
  const values = new Map<string, string>();
  return {
    get: (key: string) => values.get(key) ?? null,
    set: (key: string, value: string) => void values.set(key, value),
  };
}

/**
 * 全仓唯一按平台分叉的地方，且它只决定「装哪一组插件」。
 * 判断本身在 detect.ts，这里只做映射。
 */
export function selectHostPlugins(options: HostOptions = {}): AikaPlugin[] {
  return isTauriHost() ? tauriHostPlugins(options) : browserHostPlugins(options);
}
