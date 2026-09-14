import type { AikaPlugin } from "../../kernel";
import {
  createDesktopPetService,
  type DesktopPetServiceDeps,
} from "../../services/desktopPet/desktopPetService";
import { DesktopPetServiceToken, type DesktopPetAdapter } from "../../services/desktopPet/contracts";
import { createOpenPetAdapter } from "../../services/desktopPet/openPetAdapter";
import type { PetHttpPort } from "../../services/desktopPet/openPetProtocol";
import { createPetProcessManager, type PetProcessPort } from "../../services/desktopPet/processManager";
import { createDesktopPetSettings } from "../../services/desktopPet/settings";
import type { PetProfileV1 } from "../../services/desktopPet/profile";
import { SettingsToken } from "../../services/storage/tokens";
import { ClockToken, TimersToken } from "../../services/time/tokens";
import { createSystemClock, createSystemTimers } from "../../services/time/systemTime";
import { PET_CONFIG_DEFAULTS } from "../../services/desktopPet/contracts";
import { createPresentationLifecycle, OPENPET_PRESENTATION_MANIFEST, PresentationLifecycleToken } from "../../services/desktopPet/lifecycle";

/**
 * 外部桌宠宿主插件（PET-06）。
 *
 * 装配顺序刻意如此：**先读配置，再决定装什么**。`enabled=false` 时不 enable、
 * 不发任何请求、不启动任何进程——"关着不打扰"是这条装配的全部意义。
 *
 * 三件事在这里接起来，它们各自都不该知道对方：
 *
 * - **adapter**（协议）拿到一个地址 getter 与 profile getter，因此改端口/换角色
 *   都不需要重建对象；
 * - **ProcessManager**（进程）拿到一个探测函数与一个配置 getter；
 * - **Service**（业务语义）拿到前两者，并把每次探测结论回喂给进程管理器——
 *   它自己不轮询进程，避免出现第二条监控循环。
 *
 * 浏览器宿主不装它：`DesktopPetServiceToken` 根本不注册，消费方 `tryResolve`
 * 拿到 null 就隐藏入口。
 */

export interface DesktopPetHostOptions {
  /** 原生 HTTP 端口（`createTauriPetHttpPort`）。 */
  http: PetHttpPort;
  /** 原生进程端口（`createTauriPetProcessPort`）。 */
  process: PetProcessPort;
}

export const DESKTOP_PET_PLUGIN_ID = "host.desktopPet";

export function desktopPetPlugin(options: DesktopPetHostOptions): AikaPlugin {
  return {
    id: DESKTOP_PET_PLUGIN_ID,
    version: OPENPET_PRESENTATION_MANIFEST.version,
    requires: [SettingsToken],
    optional: [ClockToken, TimersToken],
    provides: [DesktopPetServiceToken, PresentationLifecycleToken],
    async activate(context) {
      const settings = context.registrar.resolve(SettingsToken);
      const clock = context.registrar.tryResolve(ClockToken) ?? createSystemClock();
      const timers = context.registrar.tryResolve(TimersToken) ?? createSystemTimers();

      const store = createDesktopPetSettings(settings);
      const initial = await store.read().catch(() => {
        context.logger.warn("presentation configuration unavailable; integration disabled");
        return { config: { ...PET_CONFIG_DEFAULTS }, profile: null };
      });

      // profile 与 endpoint 都是活配置：adapter 通过 getter 读，避免重建对象。
      let currentProfile: PetProfileV1 | null = initial.profile;
      let currentEndpoint = initial.config.endpoint;

      const adapter: DesktopPetAdapter = createOpenPetAdapter({
        http: options.http,
        clock,
        endpoint: () => currentEndpoint,
        profile: () => currentProfile,
      });

      // service 在 processManager 的闭包里被引用，但那些闭包只在之后才被调用。
      let service: ReturnType<typeof createDesktopPetService> | null = null;

      const processManager = createPetProcessManager({
        clock,
        timers,
        port: options.process,
        // 只读探测：走 adapter，不经过 Service（此时 Service 还在启动流程里等它）。
        probe: async () => {
          try {
            return (await adapter.status()).connection;
          } catch {
            return "offline";
          }
        },
        config: () => {
          const config = service?.config();
          return {
            mode: config?.mode ?? "attach",
            executablePath: config?.executablePath ?? null,
            autoRestart: config?.autoRestart ?? false,
            stopOwnedOnExit: config?.stopOwnedOnExit ?? false,
          };
        },
      });

      const deps: DesktopPetServiceDeps = {
        adapter,
        clock,
        timers,
        profile: currentProfile,
        config: initial.config,
        process: processManager,
        onProfileChange: (next) => {
          currentProfile = next;
        },
      };
      service = createDesktopPetService(deps);

      const instance = service;
      const lifecycle = createPresentationLifecycle(instance);
      context.registrar.provide(PresentationLifecycleToken, () => lifecycle);
      // 状态快照是唯一的同步点：每次通知都把地址与探测结论分别送给 adapter 与
      // 进程管理器。`setConfig` 会 notify，所以改端口不需要重建任何对象。
      const unsubscribe = instance.subscribe(() => {
        currentEndpoint = instance.config().endpoint;
        processManager.observe(instance.snapshot().connection);
      });

      context.registrar.provide(DesktopPetServiceToken, () => instance, {
        disposer: async () => {
          unsubscribe();
          await lifecycle.stop();
          try {
            await processManager.dispose();
          } finally {
            await instance.dispose();
          }
        },
      });

      // 启用状态在装配期就已经确定：开着的用户不该再点一次。
      if (initial.config.enabled) {
        void lifecycle.start().catch(() => {
          // 起不来就是 offline；界面显示原因并允许重连。
        });
      }
    },
  };
}
