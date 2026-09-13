/**
 * Tauri 传输适配（FE-15-A 本地部分）。
 *
 * 把 Tauri 的 invoke/listen 桥成 FE-14 的 `OutboundTransport`：
 * - 出站帧经 invoke `outbound_publish` 交给 Rust 缓存并供手机页长轮询取；
 *   Rust 侧只做字节搬运与准入，不做业务投影（那是 TS 侧 FE-14 的事）。
 * - 入站命令经 Rust 事件 `outbound://command` 下行（认证在宿主侧完成后带外
 *   注入 principal——本适配不做认证，也不信任 body 身份）。
 *
 * 用 fake invoke/listen 驱动 FE-14 transport 一致性用例包（FE-15-A）；
 * 真实 Rust handler（src-tauri/src/gateway.rs）与手机页归真实宿主轨验收。
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
  /**
   * 帧发布时携带的 TS 侧 gatewayEpoch。Rust 用它判定 epoch 变化
   * （变化即要求客户端重同步）；不传时宿主沿用已有 epoch。
   */
  gatewayEpoch?: string;
  /** 发布时归属的主体与会话；缺省用 target 里的值。 */
  principalId?: string;
}

interface PendingCommand {
  command: AuthenticatedCommand;
}

export function createTauriOutboundTransport(options: TauriTransportOptions): OutboundTransport & { ready(): Promise<void> } {
  const commandEvent = options.commandEvent ?? "outbound://command";
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
      // 发布经 Rust 中转：invoke 不等待投递结果（长轮询语义由 GET /api/v1/events 承担）。
      // 参数名 `input` 与 Rust 侧 `outbound_publish(state, input)` 对应。
      // `connection_id` 是 TS 侧的投递目标标识（Rust 只用它做会话缓存键的一部分）。
      void options.invoke("outbound_publish", {
        input: {
          principal_id: options.principalId ?? target.principalId,
          connection_id: target.connectionId,
          conversation_id: target.conversationId,
          frame,
          epoch: options.gatewayEpoch,
        },
      });
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
