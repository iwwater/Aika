import { describe, expect, it, vi } from "vitest";
import { createDesktopNotifier, createNoopNotifier } from "./notifier";

/**
 * 通知降级。
 *
 * 唯一的硬规则：`notify` 永远不抛。改造前这条规则靠调用方自己包 try/catch
 * 来保证——只要有一个调用方忘了包，一次通知失败就能把已经落库的消息
 * 从界面上抹掉。现在它是端口自己的承诺，调用方不需要知道。
 */

describe("Notifier", () => {
  it("没有通知能力的宿主如实返回 false", async () => {
    expect(await createNoopNotifier().notify({ title: "t", body: "b" })).toBe(false);
  });

  it("有权限就发出去并返回 true", async () => {
    const sendNotification = vi.fn();
    const notifier = createDesktopNotifier({
      isPermissionGranted: async () => true,
      requestPermission: async () => "granted",
      sendNotification,
    });

    expect(await notifier.notify({ title: "标题", body: "正文" })).toBe(true);
    expect(sendNotification).toHaveBeenCalledWith({ title: "标题", body: "正文" });
  });

  it("没权限就现场申请，批了照发", async () => {
    const sendNotification = vi.fn();
    const requestPermission = vi.fn(async () => "granted");
    const notifier = createDesktopNotifier({
      isPermissionGranted: async () => false,
      requestPermission,
      sendNotification,
    });

    expect(await notifier.notify({ title: "t", body: "b" })).toBe(true);
    expect(requestPermission).toHaveBeenCalledOnce();
  });

  it("用户拒绝授权：返回 false，不发，也不抛", async () => {
    const sendNotification = vi.fn();
    const notifier = createDesktopNotifier({
      isPermissionGranted: async () => false,
      requestPermission: async () => "denied",
      sendNotification,
    });

    expect(await notifier.notify({ title: "t", body: "b" })).toBe(false);
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("三条路径上任何一步抛错都被吞掉，返回 false", async () => {
    const boom = () => {
      throw new Error("notification subsystem down");
    };

    const cases = [
      createDesktopNotifier({
        isPermissionGranted: async () => boom(),
        requestPermission: async () => "granted",
        sendNotification: () => undefined,
      }),
      createDesktopNotifier({
        isPermissionGranted: async () => false,
        requestPermission: async () => boom(),
        sendNotification: () => undefined,
      }),
      createDesktopNotifier({
        isPermissionGranted: async () => true,
        requestPermission: async () => "granted",
        sendNotification: boom,
      }),
    ];

    for (const notifier of cases) {
      await expect(notifier.notify({ title: "t", body: "b" })).resolves.toBe(false);
    }
  });
});
