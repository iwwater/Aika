import { createKernel, type AikaKernel, type AikaPlugin, type KernelLogger, type KernelStartReport } from "../kernel";
import { installHttpFetch, FetchToken } from "../services/http";
import { installNotifier, NotifierToken } from "../services/notification/notifier";
import { installRemoteHost } from "../services/remote/bridge";
import { RemoteHostToken } from "../services/remote/tokens";
import { installStorageOpener } from "../services/storage";
import { installSecretStore } from "../services/storage/secretStore";
import { SecretStoreToken, StorageToken } from "../services/storage/tokens";
import { selectHostPlugins, type HostOptions } from "./hosts";

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
  /** 业务能力插件。CORE-05 起会有内容，现在为空。 */
  featurePlugins?: readonly AikaPlugin[];
  logger?: KernelLogger;
  /**
   * 是否给尚未改造的调用方装上过渡转发。
   * 默认装。CORE-06 删掉过渡层后这个开关一并消失。
   */
  installLegacyPorts?: boolean;
}

export interface Composition {
  kernel: AikaKernel;
  report: KernelStartReport;
}

export async function createAikaKernel(options: CompositionOptions = {}): Promise<Composition> {
  const kernel = createKernel({ logger: options.logger });

  for (const plugin of options.hostPlugins ?? selectHostPlugins(options)) kernel.use(plugin);
  for (const plugin of options.featurePlugins ?? []) kernel.use(plugin);

  const report = await kernel.start();
  if (options.installLegacyPorts ?? true) {
    if (report.ok) installLegacyForwarders(kernel);
    else installFailedStorageOpener(report);
  }

  return { kernel, report };
}

/**
 * 把宿主提供的实现装进过渡转发槽。
 *
 * 改造前这些具名导出各自嗅探平台；现在它们的默认值是浏览器实现，由这里替换成
 * 宿主真正提供的那个。这是 CORE-06 的删除目标，不是长期设计。
 */
function installLegacyForwarders(kernel: AikaKernel): void {
  installSecretStore(kernel.registry.resolve(SecretStoreToken));
  installHttpFetch(kernel.registry.resolve(FetchToken));
  installNotifier(kernel.registry.resolve(NotifierToken));
  // 存储用惰性闭包：调用方什么时候要，什么时候去注册表拿同一个实例。
  installStorageOpener(async () => kernel.registry.resolve(StorageToken));

  // 缺失是常态：浏览器宿主没有远程能力，这里就什么都不装，
  // remoteAvailable() 继续如实返回 false。
  const remote = kernel.registry.tryResolve(RemoteHostToken);
  if (remote) installRemoteHost(remote);
}

/**
 * 启动失败时让存储调用方看见故障，而不是悄悄退回浏览器实现。
 *
 * 这是本次改造里最容易踩的坑：过渡转发的默认值是 localStorage，桌面端一旦
 * SQLite 打不开，若不做这一步，用户会以为一切正常，实际记忆全写进了
 * localStorage。改造前 openStorage 抛错会被 Hook 显示成 storageError，
 * 这个行为必须原样保住。
 */
function installFailedStorageOpener(report: KernelStartReport): void {
  const detail = report.failed[0];
  installStorageOpener(() => Promise.reject(new Error(
    detail ? `${detail.code}: ${detail.message}` : "kernel failed to start",
  )));
}
