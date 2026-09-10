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
 * CORE-06：过渡转发已删除。通知只经 `NotifierToken` 由宿主插件提供，消费方由
 * 组合根/展示插件经构造参数注入；没有通知能力的宿主注入 `createNoopNotifier()`。
 */
