import type { AikaPlugin } from "../../kernel";
import { normalizeModeConfig } from "../../domain/soul";
import { HostLifecycleToken, RuntimeToken } from "../runtime/tokens";
import type { CompanionRuntime } from "../runtime/companionRuntime";
import type { OutboundGateway, OutboundRuntimePort } from "./outboundGateway";
import { createOutboundGateway } from "./outboundGateway";
import { OutboundGatewayToken, OutboundTransportToken } from "./tokens";
import type { AuthorizedTarget, OutboundFrameV1 } from "./contracts";

export { OutboundGatewayToken, OutboundTransportToken } from "./tokens";

/**
 * Outbound 插件（FE-14 + FE-15/16 传输接线）。
 *
 * 依赖全部来自注册表，且**都能缺**：
 * - `RuntimeToken`（required）：没有 Runtime 就没有编排，插件不该被装上。
 * - `HostLifecycleToken`（optional）：拿 `epoch()` 作 `gatewayEpoch`；缺失时
 *   退化为一次性的启动 epoch（仍然单调于本次进程）。
 * - `OutboundTransportToken`（optional）：**没有传输就没有远程**——网关照常
 *   创建（本地投影与诊断可测），只是帧无人消费。这是「能力缺失即 token
 *   不注册」在插件内部的用法。
 *
 * 命令入口默认**关闭**：只有 `commandAuthorizer` 明确给定时才接。这比
 * 「接进来再全拒」更早地关闭入口，也让「本版本不支持远程命令」这件事
 * 在装配层一眼可见。
 */
export interface OutboundPluginOptions {
  /**
   * 帧发布时携带的 gatewayEpoch 兜底值。
   *
   * 只在 HostLifecycleToken 缺失时使用；正常情况下 epoch 由宿主存活状态提供，
   * 宿主重启必然换值——那是客户端重同步的依据，不该由本插件自己造。
   */
  fallbackEpoch?: string;
  /** 命令授权端口（RT-03）。缺省 = 不接命令（fail-closed）。 */
  commandAuthorizer?: (input: AuthenticatedCommandInput) => boolean;
  /** 测试用：显式注入传输，绕过注册表。 */
  transport?: {
    publish(target: AuthorizedTarget, frame: OutboundFrameV1): void;
    onCommand(handler: (input: AuthenticatedCommandInput) => void): () => void;
  };
}

type AuthenticatedCommandInput = Parameters<OutboundGateway["handleCommand"]>[0];

/**
 * 把 `CompanionRuntime` 适配成 Gateway 需要的 `OutboundRuntimePort`。
 *
 * 两处形状差异，都在这里收口：
 * - `mode`：Gateway 只关心 `{mode: string}`（它不拥有模式配置），Runtime 要完整
 *   的 `ModeConfig`。用 `normalizeModeConfig` 补齐——非法 mode 回落默认值，
 *   Runtime 侧拿到的一定是合法完整配置。
 * - `done`：Runtime 的 `TurnSettlement` 比 Gateway 需要的 `{state}` 更宽，
 *   这里显式收窄，避免两处类型互相牵连。
 *
 * `subscribe` 不在这个端口里：它由插件直接调 `runtime.subscribe` 转发给
 * `gateway.handleRuntimeEvent`，Gateway 自己按 `turnId` 判定是否已映射，
 * 未映射的轮次直接丢弃（FE-14 的「未映射轮次零外发」）。
 */
export function createGatewayRuntimePort(runtime: CompanionRuntime): OutboundRuntimePort {
  return {
    submit: (request) => {
      const handle = runtime.submit({
        text: request.text,
        source: request.source,
        conversation: request.conversation,
        mode: normalizeModeConfig(request.mode),
      });
      return {
        turnId: handle.turnId,
        done: handle.done.then((settlement) => ({ state: settlement.state as string })),
      };
    },
    cancel: (turnId, scope) => runtime.cancel(turnId, scope),
  };
}

/** 组装网关的公共部分，供插件与测试复用（测试不经过注册表）。 */
export function createOutboundPluginGateway(input: {
  runtime: CompanionRuntime;
  gatewayEpoch: string;
  transport?: OutboundPluginOptions["transport"];
  commandAuthorizer?: OutboundPluginOptions["commandAuthorizer"];
}): { gateway: OutboundGateway; dispose(): void } {
  const gateway = createOutboundGateway({
    gatewayEpoch: input.gatewayEpoch,
    runtime: createGatewayRuntimePort(input.runtime),
  });

  // Runtime 事件 → Gateway：只要网关活着，转发就一直在。
  const unsubscribe = input.runtime.subscribe((event) => {
    gateway.handleRuntimeEvent(event);
  });

  if (input.transport) {
    gateway.attachTransport(input.transport);
    // 命令接线：无授权端口时不接命令（fail-closed）。
    const authorize = input.commandAuthorizer;
    if (authorize) {
      input.transport.onCommand((value) => {
        if (!authorize(value)) return;
        void gateway.handleCommand(value);
      });
    }
  }

  return { gateway, dispose: () => unsubscribe() };
}

export function outboundPlugin(options: OutboundPluginOptions = {}): AikaPlugin {
  return {
    id: "outbound.core",
    version: "1.0.0",
    requires: [RuntimeToken],
    optional: [HostLifecycleToken, OutboundTransportToken],
    provides: [OutboundGatewayToken],
    activate(context) {
      const runtime = context.registrar.resolve(RuntimeToken);
      const lifecycle = context.registrar.tryResolve(HostLifecycleToken);
      const transport = options.transport ?? context.registrar.tryResolve(OutboundTransportToken);

      const { gateway, dispose } = createOutboundPluginGateway({
        runtime,
        gatewayEpoch: lifecycle?.epoch() ?? options.fallbackEpoch ?? "epoch-local",
        transport: transport ?? undefined,
        commandAuthorizer: options.commandAuthorizer,
      });

      context.registrar.provide(OutboundGatewayToken, () => gateway, { disposer: dispose });
    },
  };
}
