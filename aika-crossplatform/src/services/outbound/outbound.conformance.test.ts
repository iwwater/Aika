import { describe } from "vitest";
import type { AuthenticatedCommand, AuthorizedTarget, OutboundFrameV1 } from "./contracts";
import { createOutboundGateway, type OutboundGateway } from "./outboundGateway";
import { runOutboundTransportConformance } from "./outbound.conformance";

/**
 * 内置内存 transport 跑一致性用例包（FE-14-G）。FE-15/16 的真实传输
 * （Tauri WebSocket / dev-relay）必须用同一份 harness 复跑。
 */
function harness(): {
  gateway: OutboundGateway;
  published: Array<{ connectionId: string; frame: OutboundFrameV1 }>;
  dispatchCommand(command: AuthenticatedCommand): void;
  listenerCount(): number;
} {
  const published: Array<{ connectionId: string; frame: OutboundFrameV1 }> = [];
  const listeners: Array<(input: AuthenticatedCommand) => void> = [];
  const gateway = createOutboundGateway({
    gatewayEpoch: "epoch-test",
    runtime: {
      submit: (request) => ({
        turnId: `turn-${request.text}`,
        done: Promise.resolve({ state: "completed" }),
      }),
      cancel: () => undefined,
    },
    clock: () => 1_000,
  });
  const transport = {
    publish: (target: AuthorizedTarget, frame: OutboundFrameV1) => {
      published.push({ connectionId: target.connectionId, frame });
    },
    onCommand: (handler: (input: AuthenticatedCommand) => void) => {
      listeners.push(handler);
      return () => {
        const index = listeners.indexOf(handler);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
  };
  // 与生产 plugin 相同的接线：transport 把命令喂给 gateway。
  transport.onCommand((command) => {
    void gateway.handleCommand(command);
  });
  gateway.attachTransport(transport);
  return {
    gateway,
    published,
    dispatchCommand: (command) => {
      for (const listener of [...listeners]) listener(command);
    },
    listenerCount: () => listeners.length,
  };
}

describe("outbound transport 一致性（内置内存实现，FE-15/16 复用）", () => {
  runOutboundTransportConformance({
    name: "inMemoryOutboundTransport",
    create: async () => {
      const fixture = harness();
      return {
        gateway: fixture.gateway,
        published: fixture.published,
        dispatchCommand: fixture.dispatchCommand,
        listenerCount: fixture.listenerCount,
        dispose: async () => undefined,
      };
    },
  });
});
