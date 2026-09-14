import type { AikaPlugin } from "../../kernel";
import { LOCAL_PRINCIPAL_ID } from "../../domain/identity";
import { createBrowserFetch, type HttpFetch } from "../../services/http";
import { createTauriFetch } from "../../services/http/tauriFetch";
import {
  createDesktopNotifier, createNoopNotifier, type Notifier,
} from "../../services/notification/notifier";
import { createTauriOutboundTransport } from "../../services/outbound/tauriTransport";
import { createTauriRemoteHost } from "../../services/remote/bridge";
import { createHostLifecycle, type HostLifecycle } from "../../services/runtime/hostLifecycle";
import type { AikaStorage } from "../../services/storage/contracts";
import {
  createDesktopSecretStore, createInsecureSecretStore, type SecretStore,
} from "../../services/storage/secretStore";
import { openBrowserStorage, openDesktopStorage } from "../../services/storage";
import type { Clock, Timers } from "../../services/time/tokens";
import { createSystemClock, createSystemTimers } from "../../services/time/systemTime";
import { createTauriPetHttpPort } from "../../services/desktopPet/tauriPetHttp";
import { createTauriPetProcessPort } from "../../services/desktopPet/tauriPetProcess";
import { createForegroundSource } from "../../services/environment/foregroundSource";
import { createScreenSource, SCREEN_CHANGE_EVENT } from "../../services/environment/screenSource";
import { createOcrEngine } from "../../services/environment/ocrText";
import { createCaptureScheduler } from "../../services/environment/captureScheduler";
import { environmentPlugin } from "../plugins/environmentPlugin";
import { environmentHostPlugin } from "../plugins/environmentHostPlugin";
import { desktopPetPlugin } from "./desktopPet";
import { isTauriHost } from "./detect";
import {
  fetchPlugin, hostLifecyclePlugin, notifierPlugin, outboundTransportPlugin, remotePlugin,
  secretsPlugin, settingsPlugin, storagePlugin, timePlugin,
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
  /**
   * 宿主存活状态；缺省新建一个。
   *
   * 允许注入是为了让测试用假时钟驱动「离线 → 恢复」而不用真等 15 秒，
   * 也让宿主装配层能与心跳共用同一个实例（epoch 必须一致）。
   */
  hostLifecycle?: HostLifecycle;
}

function baseHost(
  storage: () => Promise<AikaStorage>,
  secrets: SecretStore,
  notifier: Notifier,
  fetchImpl: HttpFetch,
  options: HostOptions,
  lifecycle: HostLifecycle,
): AikaPlugin[] {
  return [
    timePlugin(options.clock ?? createSystemClock(), options.timers ?? createSystemTimers()),
    storagePlugin(storage),
    secretsPlugin(secrets),
    settingsPlugin(options.onSettingsFallback),
    notifierPlugin(notifier),
    fetchPlugin(fetchImpl),
    hostLifecyclePlugin(lifecycle),
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
    resolveLifecycle(options),
  );
}

/** Tauri 桌面：SQLite + DPAPI + 系统通知 + plugin-http + 远程能力 + 出站传输。 */
/** OCR 离线资源目录：随包的 `public/tessdata`，运行时不外联。 */
const TESSDATA_PATH = "/tessdata";
/**
 * 识别语言。`eng.traineddata` 与 `chi_sim.traineddata` 都随包在 `public/tessdata`
 * 下（tessdata_fast 4.1.0，Apache-2.0，哈希登记见 THIRD_PARTY_NOTICES.md），
 * 运行时不外联；资源缺失会让 worker 创建失败 → 本次无结果，不会偷偷去网上取。
 */
const OCR_LANGUAGES = "eng+chi_sim";

export function tauriHostPlugins(options: HostOptions = {}): AikaPlugin[] {
  const lifecycle = resolveLifecycle(options);
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

  const clock = options.clock ?? createSystemClock();
  const invoke = async (command: string, args?: Record<string, unknown>): Promise<unknown> => {
    const { invoke: call } = await import("@tauri-apps/api/core");
    return call(command, args);
  };
  const listen = async (event: string, handler: (payload: unknown) => void): Promise<() => void> => {
    const { listen: subscribe } = await import("@tauri-apps/api/event");
    return subscribe(event, (payload) => handler(payload));
  };
  const environmentBridge = { invoke: invoke as <T>(c: string, a?: Record<string, unknown>) => Promise<T>, listen };
  /**
   * 环境传感器（FE-19/21）。
   *
   * 这里不预先探测平台：命令在不支持的平台上会失败，source 的 start 把失败映射成
   * `unavailable`/`denied`，设置页如实显示——比装配期猜一个 supported 布尔诚实。
   * OCR 引擎在两条轨之间共用一个实例（不另开 worker）。
   */
  const ocr = createOcrEngine({ langPath: TESSDATA_PATH, languages: OCR_LANGUAGES, clock });
  /**
   * 统一采集调度器（MVP-05-E）：在装配处**建一次**，同时注入词表轨与
   * `environmentHostPlugin`（后者用它注册 `CaptureSchedulerToken`）。
   * 以前两处各建一份，"词表轨与全文轨共用每分钟 10 次" 只是注释里的承诺。
   */
  const captureScheduler = createCaptureScheduler({ clock });
  const environmentSources = [
    createForegroundSource(environmentBridge, { hostEpoch: lifecycle.epoch() }),
    createScreenSource({
      capture: {
        listenChange: (handler) => listen(SCREEN_CHANGE_EVENT, (payload) => handler(payload as never)),
        captureRegion: async () => {
          const raw = await invoke("environment_capture_region", {});
          const result = raw as { pngBase64?: unknown } | null;
          return typeof result?.pngBase64 === "string" ? result.pngBase64 : null;
        },
        invoke: (command, args) => invoke(command, args),
      },
      ocr,
      clock,
      hostEpoch: lifecycle.epoch(),
      scheduler: captureScheduler,
    }),
  ];

  return [
    ...baseHost(() => openDesktopStorage(secrets), secrets, notifier, createTauriFetch(), options, lifecycle),
    // 环境感知（FE-18～22/31/32）：在此之前生产装配里一个传感器都没接。
    environmentPlugin({ sources: environmentSources, clock, hostEpoch: lifecycle.epoch() }),
    environmentHostPlugin({ invoke, hostEpoch: lifecycle.epoch(), ocr, scheduler: captureScheduler }),
    // 外部桌宠（PET-06）。两个端口都只认固定端点与本次 spawn 的句柄；
    // 配置默认关闭，因此装了这个插件在未启用时也是零请求、零进程。
    desktopPetPlugin({
      http: createTauriPetHttpPort(invoke),
      process: createTauriPetProcessPort({ invoke }),
    }),
    remotePlugin(createTauriRemoteHost()),
    // 出站传输：帧经 Rust 缓存供手机页长轮询；命令经 `outbound://command` 下行。
    // invoke/listen 在这里才 import——架构测试允许 `app/hosts/` 触碰 @tauri-apps。
    outboundTransportPlugin(createTauriOutboundTransport({
      invoke: async (command, args) => {
        const { invoke } = await import("@tauri-apps/api/core");
        return invoke(command, args);
      },
      listen: async (event, handler) => {
        const { listen } = await import("@tauri-apps/api/event");
        return listen(event, (payload) => handler(payload));
      },
      gatewayEpoch: lifecycle.epoch(),
      principalId: LOCAL_PRINCIPAL_ID,
    })),
  ];
}

function resolveLifecycle(options: HostOptions): HostLifecycle {
  return options.hostLifecycle ?? createHostLifecycle();
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
    resolveLifecycle(options),
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
