/**
 * Tauri 传输适配（FE-15-A 本地部分）。
 *
 * 把 Tauri 的 invoke/listen 桥成 FE-14 的 `OutboundTransport`：
 * - 出站帧经 Rust 事件 `outbound://frame` 推给手机页（payload = {target, frame}）。
 * - 入站命令经 invoke `outbound_command` 上行，由 Rust 转交主窗（认证在宿主侧
 *   完成后带外注入 principal——本适配不做认证，也不信任 body 身份）。
 *
 * 用 fake invoke/listen 驱动 FE-14 transport 一致性用例包（FE-15-A）；
 * 真实 Rust handler（src-tauri gateway.rs）与手机页归真实宿主轨验收。
 */

import type { AuthenticatedCommand, AuthorizedTarget, OutboundFrameV1, OutboundTransport } from "./contracts";

/** Tauri event listen 的最小形状（避免 import @tauri-apps/api 便于 fake）。 */
export type TauriListen = (event: string, handler: (event: { payload: unknown }) => void) => Promise<() => void>;
export type TauriInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

export interface TauriTransportOptions {
  invoke: TauriInvoke;
  listen: TauriListen;
  /** 命令到达事件名（Rust 端 emit）。 */
  commandEvent?: string;
  /** 出站帧事件名（TS→Rust→手机页）。 */
  frameEvent?: string;
}

interface PendingCommand {
  command: AuthenticatedCommand;
}

export function createTauriOutboundTransport(options: TauriTransportOptions): OutboundTransport & { ready(): Promise<void> } {
  const commandEvent = options.commandEvent ?? "outbound://command";
  void (options.frameEvent ?? "outbound://frame");
  const commandHandlers: Array<(input: AuthenticatedCommand) => void> = [];
  let started = false;

  return {
    async ready() {
      if (started) return;
      started = true;
      await options.listen(commandEvent, (event) => {
        const raw = event.payload as PendingCommand | null;
        if (!raw?.command) return;
        for (const handler of [...commandHandlers]) {
          try {
            handler(raw.command);
          } catch {
            // 一个监听者抛错不影响其它监听者与传输（FE-14-G 隔离语义）。
          }
        }
      });
    },

    publish(target: AuthorizedTarget, frame: OutboundFrameV1): void {
      // 发布经 Rust 中转：invoke 不等待投递结果（长轮询语义由 GET /events 分页承担）。
      void options.invoke("outbound_publish", { target, frame });
    },

    onCommand(handler) {
      commandHandlers.push(handler);
      return () => {
        const index = commandHandlers.indexOf(handler);
        if (index >= 0) commandHandlers.splice(index, 1);
      };
    },
  };
}
