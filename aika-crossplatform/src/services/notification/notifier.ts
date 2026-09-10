import { token } from "../../kernel";

/**
 * 通知端口。
 *
 * 唯一的硬规则：`notify` 永远不抛。通知失败不该影响已经落库的消息——
 * 用户打开窗口就能看到那条消息，没弹出系统通知只是少了一次提醒。
 * 所以失败以返回 false 表达，调用方不需要 try/catch。
 */
export interface Notifier {
  /** true 表示确实发出去了；无权限、宿主不支持、底层抛错都返回 false。 */
  notify(input: { title: string; body: string }): Promise<boolean>;
}

export const NotifierToken = token<Notifier>("notification.notifier");

/** 浏览器与测试宿主用：什么都不做，但如实回答「没发出去」。 */
export function createNoopNotifier(): Notifier {
  return { notify: async () => false };
}

export interface DesktopNotifierPorts {
  isPermissionGranted(): Promise<boolean>;
  requestPermission(): Promise<string>;
  sendNotification(input: { title: string; body: string }): void;
}

/**
 * 桌面通知。
 *
 * 权限查询、请求、发送三步任何一步抛错都吞掉并返回 false；端口注入是为了
 * 让这三条路径都能在没有 Tauri 的环境里测到。
 */
export function createDesktopNotifier(ports: DesktopNotifierPorts): Notifier {
  return {
    async notify(input) {
      try {
        const granted = (await ports.isPermissionGranted())
          || (await ports.requestPermission()) === "granted";
        if (!granted) return false;
        ports.sendNotification(input);
        return true;
      } catch {
        return false;
      }
    },
  };
}

/**
 * 过渡转发。useCompanionSession 还没接注册表，先用这个具名导出。
 * 默认什么都不做——**默认值不再靠嗅探平台得来**。CORE-06 删除本段。
 */
let installed: Notifier | null = null;

export function installNotifier(notifier: Notifier): void {
  installed = notifier;
}

/** 测试用：把过渡槽恢复到未安装状态。 */
export function resetInstalledNotifier(): void {
  installed = null;
}

/** @deprecated 过渡用，改从注册表取 NotifierToken；CORE-06 删除。 */
export function activeNotifier(): Notifier {
  return installed ?? NOOP;
}

const NOOP: Notifier = { notify: async () => false };
