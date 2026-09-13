import type { AikaPlugin } from "../../kernel";
import { token } from "../../kernel";
import type { OutboundGateway } from "./outboundGateway";
import { createOutboundGateway } from "./outboundGateway";
import type { AuthorizedTarget, OutboundFrameV1 } from "./contracts";

/**
 * Outbound 插件（FE-14）。
 *
 * 两个「缺失即不接入」的边界：
 * - **没有 transport**（FE-15/16 才提供真实传输）：插件整体 skipped，
 *   启动不受阻。
 * - **没有授权端口**（RT-03/绑定未装配）：Gateway 照常创建但**不接命令**——
 *   只有帧外发能力，任何远程命令都进不来（fail-closed）。
 */
export const OutboundGatewayToken = token<OutboundGateway>("outbound.gateway");

export interface OutboundPluginOptions {
  gatewayEpoch: string;
  /** 真实传输（FE-15/16）。缺省 = 无 transport，插件 skipped。 */
  transport?: {
    publish(target: AuthorizedTarget, frame: OutboundFrameV1): void;
    onCommand(handler: (input: AuthenticatedCommandInput) => void): () => void;
  };
  /** 命令授权端口：命令体带外注入的主体要经它二次核验。 */
  commandAuthorizer?: (input: AuthenticatedCommandInput) => boolean;
  runtime: {
    subscribe(listener: (event: never) => void): () => void;
  };
}

type AuthenticatedCommandInput = Parameters<OutboundGateway["handleCommand"]>[0];

export function outboundPlugin(_options: OutboundPluginOptions): AikaPlugin {
  return {
    id: "outbound.core",
    version: "1.0.0",
    provides: [OutboundGatewayToken],
    activate(context) {
      // 第一版组合根尚未接 Runtime subscribe（CORE-03 Hook 切换后接线），
      // gateway 以手动 handleRuntimeEvent 的形状提供；transport 缺失时
      // 仍然注册 gateway 本身（本地投影可测），但帧无人消费即丢弃。
      const gateway = createOutboundGateway({
        gatewayEpoch: _options.gatewayEpoch,
        runtime: {
          submit: () => {
            throw new Error("outboundPlugin 需要 runtime 端口注入（GW/FE-15 接线）");
          },
          cancel: () => undefined,
        },
      });
      if (_options.transport) {
        gateway.attachTransport(_options.transport);
        // 命令接线：无授权端口时不接命令（fail-closed）。
        if (_options.commandAuthorizer) {
          _options.transport.onCommand((input) => {
            if (!_options.commandAuthorizer?.(input)) return;
            void gateway.handleCommand(input as Parameters<OutboundGateway["handleCommand"]>[0]);
          });
        }
      }
      context.registrar.provide(OutboundGatewayToken, () => gateway);
    },
  };
}
