import type { AikaPlugin } from "../../kernel";
import { createBrowserFetch, FetchToken, type HttpFetch } from "../../services/http";
import {
  createNoopNotifier, NotifierToken, type Notifier,
} from "../../services/notification/notifier";
import { RemoteHostToken } from "../../services/remote/tokens";
import type { RemoteHost } from "../../services/remote/bridge";
import type { OutboundTransport } from "../../services/outbound/contracts";
import { OutboundTransportToken } from "../../services/outbound/tokens";
import type { AikaStorage } from "../../services/storage/contracts";
import { createInsecureSecretStore, type SecretStore } from "../../services/storage/secretStore";
import { createSettingsStore } from "../../services/storage/settingsStore";
import { SecretStoreToken, SettingsToken, StorageToken } from "../../services/storage/tokens";
import { createSystemClock, createSystemTimers } from "../../services/time/systemTime";
import { ClockToken, TimersToken, type Clock, type Timers } from "../../services/time/tokens";
import { HostLifecycleToken } from "../../services/runtime/tokens";
import { createHostLifecycle, type HostLifecycle } from "../../services/runtime/hostLifecycle";

/**
 * 宿主插件工厂。
 *
 * 每个插件只做一件事：声明它要什么、给什么，然后把实现注册上去。它们不知道
 * 自己在哪个平台上跑——平台差异体现为「组合根装了哪一组」，不是插件内部的分支。
 */

const VERSION = "1.0.0";

/** 时钟与计时器。默认系统实现；测试宿主换成假的，被测代码一行不改。 */
export function timePlugin(clock: Clock, timers: Timers): AikaPlugin {
  return {
    id: "host.time",
    version: VERSION,
    provides: [ClockToken, TimersToken],
    activate(context) {
      context.registrar.provide(ClockToken, () => clock);
      context.registrar.provide(TimersToken, () => timers);
    },
  };
}

/**
 * 存储。
 *
 * 开库是异步的，而服务工厂是同步的——所以在 activate 里 await 一次，注册进去的
 * 是已经可用的 AikaStorage。让消费方拿到 `Promise<AikaStorage>` 才是更坏的选择：
 * 每个用到存储的地方都要多一次 await，还得各自处理开库失败。
 *
 * 代价是启动时就开库。这与改造前的行为一致（原本也在启动流程里 openStorage），
 * 且 settingsPlugin 硬依赖它，无论如何都会在激活阶段被解析。
 * 开库失败 = 该插件激活失败 = 内核逆序回滚并落到 failed，不会留一个半可用的应用。
 */
export function storagePlugin(open: () => Promise<AikaStorage>): AikaPlugin {
  return {
    id: "host.storage",
    version: VERSION,
    provides: [StorageToken],
    async activate(context) {
      const storage = await open();
      context.registrar.provide(StorageToken, () => storage);
    },
  };
}

/** 密钥。桌面走 DPAPI，浏览器走明文回退，两者都是完整实现，不是内部分叉。 */
export function secretsPlugin(secrets: SecretStore): AikaPlugin {
  return {
    id: "host.secrets",
    version: VERSION,
    provides: [SecretStoreToken],
    activate(context) {
      context.registrar.provide(SecretStoreToken, () => secrets);
    },
  };
}

/** 设置。它是本组里唯一有硬依赖的插件，顺带验证了拓扑排序确实在起作用。 */
export function settingsPlugin(onFallback?: (key: string, reason: string) => void): AikaPlugin {
  return {
    id: "host.settings",
    version: VERSION,
    requires: [StorageToken],
    provides: [SettingsToken],
    activate(context) {
      const storage = context.registrar.resolve(StorageToken);
      context.registrar.provide(SettingsToken, () => createSettingsStore(storage, { onFallback }));
    },
  };
}

export function notifierPlugin(notifier: Notifier = createNoopNotifier()): AikaPlugin {
  return {
    id: "host.notifier",
    version: VERSION,
    provides: [NotifierToken],
    activate(context) {
      context.registrar.provide(NotifierToken, () => notifier);
    },
  };
}

export function fetchPlugin(fetchImpl: HttpFetch = createBrowserFetch()): AikaPlugin {
  return {
    id: "host.fetch",
    version: VERSION,
    provides: [FetchToken],
    activate(context) {
      context.registrar.provide(FetchToken, () => fetchImpl);
    },
  };
}

/**
 * 远程能力。**只有桌面宿主装它。**
 *
 * 没有这个插件时 RemoteHostToken 根本不存在，消费方 tryResolve 拿到 null 就
 * 隐藏入口。这比注册一个「调用即抛错」的假实现诚实得多。
 */
export function remotePlugin(host: RemoteHost): AikaPlugin {
  return {
    id: "host.remote",
    version: VERSION,
    provides: [RemoteHostToken],
    activate(context) {
      context.registrar.provide(RemoteHostToken, () => host);
    },
  };
}

/**
 * 出站传输。**只有具备远程能力的宿主装它**（桌面 Tauri、浏览器 dev-relay）。
 *
 * 与 remotePlugin 同理：没有这个插件时 OutboundTransportToken 根本不存在，
 * outbound 插件照常注册网关（本地投影可测），只是帧没有去处——这正是
 * 「能力缺失即 token 不注册」的用法，比注册一个「发布即丢弃」的假实现诚实。
 *
 * `ready()` 不在这里 await：activate 保持同步，宿主可在装配后自行等待
 * （Tauri 的 listen 注册需要一次异步摸底）。失败由调用方处理，不静默吞掉。
 */
export function outboundTransportPlugin(transport: OutboundTransport): AikaPlugin {
  return {
    id: "host.outboundTransport",
    version: VERSION,
    provides: [OutboundTransportToken],
    activate(context) {
      context.registrar.provide(OutboundTransportToken, () => transport);
    },
  };
}

/**
 * 宿主存活状态（RT-01-D）。
 *
 * 装上它，`HostLifecycleToken` 才存在；远端出站与诊断面板据此拿 `epoch()`。
 * 心跳由宿主装配层负责喂（见 `app/hosts/index.ts` 的 `startHostHeartbeat`）——
 * 插件本身不启动定时器，是为了让「谁在喂心跳」可被测试替换，也让 dispose
 * 只做一件事：解除订阅。
 */
export function hostLifecyclePlugin(lifecycle: HostLifecycle = createHostLifecycle()): AikaPlugin {
  return {
    id: "host.lifecycle",
    version: VERSION,
    provides: [HostLifecycleToken],
    activate(context) {
      context.registrar.provide(HostLifecycleToken, () => lifecycle, {
        disposer: () => lifecycle.dispose(),
      });
    },
  };
}

export function defaultTimePlugin(): AikaPlugin {
  return timePlugin(createSystemClock(), createSystemTimers());
}

export function insecureSecretsPlugin(): AikaPlugin {
  return secretsPlugin(createInsecureSecretStore());
}
