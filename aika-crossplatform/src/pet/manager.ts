import { createPetRelay, type PetRelay } from "./relay";
import type { PetPresentationData, PetTimers } from "./petPresentation";

/**
 * 桌宠窗口生命周期管理（FE-20 2026-09-14 修订）。
 *
 * 生成号（generation）裁决竞态：「创建中 hide」使该次创建失效，迟到窗口立即销毁；
 * 重复 show 只保留一个窗口。主窗 Runtime 与 TTS 在整个流程里 cancel/stop 调用
 * 为零——关闭桌宠绝不取消主窗对话（FE-20-G）。
 *
 * 中继只在窗口打开期间运行；关闭即解绑订阅、停掉节流循环。
 */

export interface PetWindowPort {
  invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
  /** relay 接收 pet 快照请求事件用（与 EnvironmentBridge 同形状）。 */
  listen(event: string, handler: (payload: unknown) => void): Promise<() => void>;
}

export interface PetWindowManagerDeps {
  bridge: PetWindowPort;
  /** 主窗聚合快照（relay 用）。 */
  aggregate(): PetPresentationData;
  epoch: string;
  timers: PetTimers;
  throttleMs?: number;
}

export interface PetWindowManager {
  /** 打开（幂等：已开则 no-op）。返回是否真正发起了创建。 */
  open(): Promise<void>;
  /** 关闭（幂等）。销毁窗口并解绑中继订阅。 */
  close(): Promise<void>;
  /** 切换点击穿透；主窗必须保留关闭穿透的入口。 */
  setClickThrough(enabled: boolean): Promise<void>;
  /** 找回：工作区居中并关闭穿透。 */
  resetPosition(): Promise<void>;
  readonly relay: PetRelay;
  isOpen(): boolean;
  /** 当前 generation（诊断/测试用）。 */
  generation(): number;
}

export function createPetWindowManager(deps: PetWindowManagerDeps): PetWindowManager {
  let currentGeneration = 0;
  let open = false;
  let pendingOpen = false;
  const relay = createPetRelay({
    bridge: deps.bridge,
    aggregate: deps.aggregate,
    epoch: deps.epoch,
    timers: deps.timers,
    ...(deps.throttleMs !== undefined ? { throttleMs: deps.throttleMs } : {}),
    // 窗口开着才广播：Rust 侧对不存在窗口 emit 无害，但这里不白付 IPC。
    isWindowOpen: () => open,
  });

  async function showWindow(): Promise<void> {
    await deps.bridge.invoke("pet_window_show", {});
  }

  async function hideWindow(): Promise<void> {
    await deps.bridge.invoke("pet_window_hide", {});
  }

  return {
    relay,

    async open(): Promise<void> {
      // 幂等：窗口已开时重复 open 不再发命令（Rust 侧重复 show 只会重复聚焦）。
      if (open) return;
      pendingOpen = true;
      try {
        const generation = ++currentGeneration;
        await showWindow();
        // 竞态裁决：show 期间被 hide/close 超越 → 迟到的窗口立即销毁。
        if (generation !== currentGeneration) {
          await hideWindow();
          return;
        }
        if (!open) {
          open = true;
          await relay.start();
        }
      } finally {
        pendingOpen = false;
      }
    },

    async close(): Promise<void> {
      // 幂等：窗口已关且没有在途创建时，重复 close 不再发命令。
      if (!open && !pendingOpen) return;
      open = false;
      // generation 前移：在途 open 的 show 返回后按旧 generation 自行销毁。
      currentGeneration += 1;
      await relay.stop();
      await hideWindow();
    },

    async setClickThrough(enabled: boolean): Promise<void> {
      if (!open) return;
      await deps.bridge.invoke("pet_window_set_click_through", { enabled });
    },

    async resetPosition(): Promise<void> {
      if (!open) return;
      await deps.bridge.invoke("pet_window_reset_position", {});
    },

    isOpen(): boolean {
      return open;
    },

    generation(): number {
      return currentGeneration;
    },
  };
}
