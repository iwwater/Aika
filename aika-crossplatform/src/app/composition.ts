import { createKernel, type AikaKernel, type AikaPlugin, type KernelLogger, type KernelStartReport } from "../kernel";
import { createNoopNotifier } from "../services/notification/notifier";
import { installHttpFetch, FetchToken } from "../services/http";
import { OutboundTransportToken } from "../services/outbound/tokens";
import { installRemoteHost } from "../services/remote/bridge";
import { RemoteHostToken } from "../services/remote/tokens";
import { HostLifecycleToken, ProviderSettingsToken, RuntimeToken } from "../services/runtime/tokens";
import { installSecretStore } from "../services/storage/secretStore";
import { SecretStoreToken } from "../services/storage/tokens";
import { TimersToken } from "../services/time/tokens";
import { createPresentationServices, type PresentationServiceDeps } from "../presentation/services";
import type { PresentationServices } from "../presentation/fallback";
import { capabilityPlugins } from "./plugins";
import { presentationPlugin } from "./plugins/presentationPlugin";
import { selectHostPlugins, type HostOptions } from "./hosts";
import type { ServiceResolver } from "./plugins/petClickReactionPlugin";

/**
 * 组合根。
 *
 * 整个应用只有这一个地方知道「谁跟谁装在一起」。它也是 CORE-01-D 白名单里
 * 允许调用 `registry.resolve` 的文件之一——业务代码通过构造参数拿依赖，
 * 只有组合根、插件 activate 和 React 的 useService 可以主动去注册表里取。
 */

export interface CompositionOptions extends HostOptions {
  /** 覆盖宿主插件；测试传 testHostPlugins(...)。不传就按平台选。 */
  hostPlugins?: readonly AikaPlugin[];
  /** 业务能力插件；不传用 `capabilityPlugins()`。 */
  featurePlugins?: readonly AikaPlugin[];
  /** 展示层依赖；测试可注入 fake Runtime / 假引擎。 */
  presentation?: PresentationServiceDeps;
  logger?: KernelLogger;
  /**
   * 是否给尚未插件化的调用方（Remote 手机端、本地 Whisper）装上过渡转发。
   * 默认装；`installLegacyPorts:false` 主要给不关心这些全局槽的测试用。
   */
  installLegacyPorts?: boolean;
}

export interface Composition {
  kernel: AikaKernel;
  report: KernelStartReport;
  /** 仅在内核启动失败时非空：交给 KernelProvider 兜底，界面仍能渲染并显示故障。 */
  presentation: PresentationServices | null;
}

export async function createAikaKernel(options: CompositionOptions = {}): Promise<Composition> {
  const kernel = createKernel({ logger: options.logger });

  /**
   * 启动后解析器：给需要**延后解析**的宿主插件用（见 `HostOptions.resolve`）。
   *
   * Presenter 是惰性构造的，而它们的工厂要求内核已 ready——启动期间解析会报
   * `kernel is starting`；插件的 registrar 在 activate 返回后又失效。所以把解析
   * 能力从这里递出去，让插件在真正用的时候（点击到达）再取。
   * 组合根本来就是白名单里允许调用 `registry.resolve` 的地方。
   */
  const resolveService: ServiceResolver = (token) => {
    try {
      return kernel.registry.tryResolve(token);
    } catch {
      // 内核 failed 之后 tryResolve 也会抛：一律按「没有这个能力」处理。
      return null;
    }
  };

  const hostOptions: HostOptions = { ...options, resolve: options.resolve ?? resolveService };
  for (const plugin of options.hostPlugins ?? selectHostPlugins(hostOptions)) kernel.use(plugin);
  // 默认装配能力插件；测试或特殊宿主可显式覆盖。
  for (const plugin of options.featurePlugins ?? capabilityPlugins()) kernel.use(plugin);
  // 展示层在内核里也是普通插件：注册表提供实例，Hook 经 useService 取。
  // 运行时用惰性闭包取：没人解析 Presenter 时不会顺带实例化 Runtime。
  kernel.use(presentationPlugin({
    resolveRuntime: () => {
      const runtime = kernel.registry.tryResolve(RuntimeToken);
      const settings = kernel.registry.tryResolve(ProviderSettingsToken);
      return runtime && settings ? { runtime, settings } : null;
    },
  }));

  const report = await kernel.start();
  if (options.installLegacyPorts ?? true) {
    if (report.ok) installLegacyForwarders(kernel);
    // 启动失败时不装任何转发：兜底 Presenter 直接用抛错的 loadStorage 把故障显示出来。
  }
  if (report.ok) await startHostRuntime(kernel);

  // 成功时注册表就是唯一来源；失败时注册表不可用，才需要兜底实例。
  const presentation = report.ok ? null : failedPresentation(report, options.presentation);

  return { kernel, report, presentation };
}

/**
 * 尚未插件化的两处调用方的过渡入口。
 *
 * - Remote 手机端（`useRemoteAccess`）还要用宿主的密钥库存访问口令，并用远程宿主
 *   接收手机请求；
 * - 本地 Whisper 的 HTTP 出口走 `activeFetch`（Tauri 下走 plugin-http）。
 *
 * 它们都不属于对话编排，因此与 CORE-06 的「单一编排路径」无关；插件化留给后续
 * Remote/语音插件 SPEC，不在这里顺手改名。
 */
function installLegacyForwarders(kernel: AikaKernel): void {
  installSecretStore(kernel.registry.resolve(SecretStoreToken));
  installHttpFetch(kernel.registry.resolve(FetchToken));

  // 缺失是常态：浏览器宿主没有远程能力，这里就什么都不装，
  // remoteAvailable() 继续如实返回 false。
  const remote = kernel.registry.tryResolve(RemoteHostToken);
  if (remote) installRemoteHost(remote);
}

/**
 * 宿主装配后的启动动作（FE-17-host）。
 *
 * 两件事，都**不阻断启动**：远程是可选能力，它出问题不该让整个应用起不来。
 *
 * 1. **传输摸底**：Tauri 的 `listen("outbound://command")`、WS 的连接建立都是
 *    异步的。必须 await 之后才算真正就绪——否则命令可能在监听器装好前到达而丢。
 *    失败只记录，`OutboundGatewayToken` 仍可用（本地投影照常工作）。
 * 2. **心跳**：`HostLifecycle` 的租约 15s 到期即判 offline，而 epoch 是远端
 *    重同步的依据。这里按租约的 1/3 喂 `markAlive()`，留出两次容错。
 *
 * `markStopping()` 挂在窗口的 `beforeunload`/`pagehide` 上：桌面关 WebView 时
 * 立即 offline，不必等租约过期——这正是三态存在的理由。
 */
async function startHostRuntime(kernel: AikaKernel): Promise<void> {
  const transport = kernel.registry.tryResolve(OutboundTransportToken);
  if (transport?.ready) {
    try {
      await transport.ready();
    } catch (error) {
      // 传输起不来 = 这台机器暂时没有远程；本地一切照旧（网关仍在注册表里）。
      console.warn("[host] outbound transport 就绪失败，远程不可用", error);
    }
  }

  const lifecycle = kernel.registry.tryResolve(HostLifecycleToken);
  const timers = kernel.registry.tryResolve(TimersToken);
  if (!lifecycle || !timers) return;

  // 按租约（默认 15s）的 1/3 喂心跳，留两次容错。
  const HEARTBEAT_MS = 5_000;
  let stopped = false;
  let handle: unknown = null;

  const tick = () => {
    if (stopped) return;
    lifecycle.markAlive();
    handle = timers.setTimeout(tick, HEARTBEAT_MS);
  };
  handle = timers.setTimeout(tick, HEARTBEAT_MS);

  const stop = () => {
    stopped = true;
    if (handle !== null) timers.clearTimeout(handle);
    // 关窗即 offline：不等租约过期，远端立刻知道宿主走了。
    lifecycle.markStopping();
  };
  if (typeof globalThis.addEventListener === "function") {
    globalThis.addEventListener("pagehide", stop, { once: true });
  }
}

/**
 * 启动失败时的兜底 Presenter。
 *
 * 界面必须能渲染并告诉用户「本地存储打不开，这次的对话和记忆不会被保存」，
 * 所以这里注入一个**必定失败**的 loadStorage，让错误经同一条 storageError 通道显示，
 * 而不是悄悄退回浏览器实现、让用户以为一切正常。
 */
function failedPresentation(
  report: KernelStartReport,
  override?: PresentationServiceDeps,
): PresentationServices {
  const detail = report.failed[0];
  const message = detail ? `${detail.code}: ${detail.message}` : "kernel failed to start";
  return createPresentationServices({
    companion: override?.companion ?? {
      loadStorage: () => Promise.reject(new Error(message)),
      notifier: createNoopNotifier(),
      runtime: null,
    },
    voice: override?.voice,
  });
}
