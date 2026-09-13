import { describe } from "vitest";
import type { AuthenticatedCommand, OutboundFrameV1 } from "./contracts";
import { createOutboundGateway, type OutboundGateway } from "./outboundGateway";
import { runOutboundTransportConformance } from "./outbound.conformance";
import { createTauriOutboundTransport } from "./tauriTransport";

/**
 * FE-15-A：fake invoke/listen 下复跑 FE-14 transport 一致性用例包。
 * 退订无迟到业务回调：gateway 退订后，即使 Tauri 事件继续到达也不产生业务帧。
 */
describe("tauriTransport 一致性（FE-15-A，fake invoke/listen）", () => {
  runOutboundTransportConformance({
    name: "tauriOutboundTransport（fake invoke/listen）",
    create: async () => {
      const published: Array<{ connectionId: string; frame: OutboundFrameV1 }> = [];
      let commandListener: ((event: { payload: unknown }) => void) | null = null;
      let idCounter = 0;
      const invoke = async (command: string, args?: Record<string, unknown>) => {
        if (command === "outbound_publish" && args) {
          // 生产参数形状：{ input: { principal_id, connection_id, conversation_id, frame, epoch } }
          const input = args.input as { connection_id: string; frame: OutboundFrameV1 };
          published.push({ connectionId: input.connection_id, frame: input.frame });
        }
        return null;
      };
      const listen = async (_event: string, handler: (event: { payload: unknown }) => void) => {
        commandListener = handler;
        return () => {
          commandListener = null;
        };
      };

      const transport = createTauriOutboundTransport({ invoke, listen });
      const gateway: OutboundGateway = createOutboundGateway({
        gatewayEpoch: "epoch-tauri",
        runtime: {
          submit: (request) => ({
            turnId: `turn-${request.text}-${(idCounter += 1)}`,
            done: Promise.resolve({ state: "completed" }),
          }),
          cancel: () => undefined,
        },
        clock: () => 1_000,
      });
      // 与生产 outboundPlugin 相同的接线：transport 命令事件 → gateway。
      transport.onCommand((command) => {
        void gateway.handleCommand(command);
      });
      gateway.attachTransport(transport);
      await transport.ready();

      return {
        gateway,
        published,
        dispatchCommand: (command: AuthenticatedCommand) => {
          // 模拟 Rust 侧 emit 命令事件。
          commandListener?.({ payload: { command } });
        },
        listenerCount: () => 1,
        dispose: async () => undefined,
      };
    },
  });
});
