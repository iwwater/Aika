import { afterEach, describe, expect, it, vi } from "vitest";
import type { AikaPlugin } from "../../kernel";
import { HostLifecycleToken } from "../../services/runtime/tokens";
import type { AuthenticatedCommand, OutboundFrameV1 } from "../../services/outbound/contracts";
import { OutboundGatewayToken, OutboundTransportToken } from "../../services/outbound/tokens";
import { createOutboundPluginGateway, outboundPlugin } from "../../services/outbound/outboundPlugin";
import type { CompanionRuntime } from "../../services/runtime/companionRuntime";
import { createHostLifecycle } from "../../services/runtime/hostLifecycle";
import { resetInstalledSecretStore } from "../../services/storage/secretStore";
import { resetInstalledRemoteHost } from "../../services/remote/bridge";
import type { AikaStorage } from "../../services/storage/contracts";
import { createSqliteStorage } from "../../services/storage/sqliteStorage";
import { openMemorySqlite } from "../../services/storage/nodeSqlite.harness";
import { createAikaKernel } from "../composition";
import { testHostPlugins } from "../hosts";
import { hostLifecyclePlugin, outboundTransportPlugin } from "../hosts/plugins";
import { capabilityPlugins } from "../plugins";

/**
 * FE-17-host/tauri：宿主装配接线。
 *
 * 验证的是**装配层**的三条可证伪结论，而不是重跑 FE-14 的投影逻辑：
 * 1. 没有传输的宿主：`OutboundTransportToken` 不存在，网关仍可解析（本地投影可用），
 *    且**命令入口关闭**——不是「接进来再全拒」。
 * 2. 有传输的宿主：帧真的经 transport 出去；`ready()` 被宿主启动流程 await。
 * 3. `gatewayEpoch` 来自宿主存活状态（RT-01-D），宿主重启即换 epoch。
 */

afterEach(() => {
  resetInstalledSecretStore();
  resetInstalledRemoteHost();
});

async function realStorage(): Promise<AikaStorage> {
  const { executor } = openMemorySqlite();
  return createSqliteStorage(executor);
}

/** 记录调用的内存传输：不依赖 @tauri-apps，专门证装配而不是证协议。 */
function recordingTransport() {
  const published: Array<{ conversationId: string; frame: OutboundFrameV1 }> = [];
  const commandHandlers: Array<(input: AuthenticatedCommand) => void> = [];
  let readyCalls = 0;
  return {
    published,
    readyCalls: () => readyCalls,
    emitCommand(command: AuthenticatedCommand) {
      for (const handler of commandHandlers) handler(command);
    },
    transport: {
      publish: (target: { conversationId: string }, frame: OutboundFrameV1) => {
        published.push({ conversationId: target.conversationId, frame });
      },
      onCommand: (handler: (input: AuthenticatedCommand) => void) => {
        commandHandlers.push(handler);
        return () => {
          const index = commandHandlers.indexOf(handler);
          if (index >= 0) commandHandlers.splice(index, 1);
        };
      },
      ready: async () => {
        readyCalls += 1;
      },
    },
  };
}

describe("FE-17-host 出站装配：能力缺失即 token 不注册", () => {
  it("宿主没有传输：网关仍注册（本地投影可用），但 OutboundTransportToken 不存在", async () => {
    const { kernel, report } = await createAikaKernel({
      hostPlugins: testHostPlugins({ storage: await realStorage() }),
      installLegacyPorts: false,
    });

    expect(report.ok).toBe(true);
    expect(kernel.registry.has(OutboundGatewayToken)).toBe(true);
    expect(kernel.registry.tryResolve(OutboundGatewayToken)).not.toBeNull();
    // 关键：不是注册一个「发布即丢弃」的假传输，而是根本没有这个 token。
    expect(kernel.registry.has(OutboundTransportToken)).toBe(false);

    await kernel.dispose();
  });

  it("宿主装了传输：token 可解析，且经内核装配的网关把帧发到它上面", async () => {
    const recording = recordingTransport();
    const storage = await realStorage();
    const { kernel, report } = await createAikaKernel({
      hostPlugins: [
        ...testHostPlugins({ storage }),
        outboundTransportPlugin(recording.transport),
      ],
      installLegacyPorts: false,
    });

    expect(report.ok).toBe(true);
    expect(kernel.registry.resolve(OutboundTransportToken)).toBe(recording.transport);

    const gateway = kernel.registry.resolve(OutboundGatewayToken);
    // 未映射轮次零外发：先证明「没登记就不发」。
    gateway.handleRuntimeEvent({
      turnId: "unmapped", seq: 1, type: "generated",
      reply: { replyText: "hi", translation: null, mood: "neutral", actions: [] },
    } as never);
    expect(recording.published).toEqual([]);

    // 登记映射后再发同一轮：这次必须出去。
    gateway.registerTarget("mapped", { connectionId: "c1", conversationId: "conv-1", principalId: "local" });
    gateway.handleRuntimeEvent({
      turnId: "mapped", seq: 2, type: "generated",
      reply: { replyText: "hi", translation: null, mood: "neutral", actions: [] },
    } as never);
    expect(recording.published).toHaveLength(1);
    expect(recording.published[0].conversationId).toBe("conv-1");
    expect(recording.published[0].frame.payload.channel).toBe("reply");

    await kernel.dispose();
  });
});

describe("FE-17-host 命令入口 fail-closed", () => {
  it("没有授权端口：transport 上的命令监听器根本没有被接上", async () => {
    const recording = recordingTransport();
    const { kernel } = await createAikaKernel({
      hostPlugins: [
        ...testHostPlugins({ storage: await realStorage() }),
        outboundTransportPlugin(recording.transport),
      ],
      // 显式构造无 commandAuthorizer 的 outbound 插件：缺省就是 fail-closed。
      // （生产装配现在自带授权，见下一个用例；这里锁的是缺省语义。）
      featurePlugins: [
        ...capabilityPlugins().filter((plugin) => plugin.id !== "outbound.core"),
        outboundPlugin({}),
      ],
      installLegacyPorts: false,
    });

    // 命令进来也没有任何监听者响应：不是「接了再拒」，而是入口没开。
    const gateway = kernel.registry.resolve(OutboundGatewayToken);
    const spy = vi.spyOn(gateway, "handleCommand");
    recording.emitCommand({
      raw: { schemaVersion: 1, type: "ping", requestId: "r1" },
      principal: { principalId: "local" },
      conversationId: "conv-1",
      connectionId: "c1",
    });
    expect(spy).not.toHaveBeenCalled();

    await kernel.dispose();
  });

  it("有授权端口：只有被授权的命令才流到网关，未授权命令被丢弃", async () => {
    const recording = recordingTransport();
    const authorized = vi.fn((input: AuthenticatedCommand) => input.principal.principalId === "local");
    const { kernel, report } = await createAikaKernel({
      hostPlugins: [
        ...testHostPlugins({ storage: await realStorage() }),
        outboundTransportPlugin(recording.transport),
      ],
      // 默认能力清单已含 outbound.core；这里**替换**它而不是叠加——
      // 叠加会因两个插件提供同一 token 而触发 PLUGIN_PROVIDER_CONFLICT。
      featurePlugins: [
        ...capabilityPlugins().filter((plugin) => plugin.id !== "outbound.core"),
        outboundPlugin({ commandAuthorizer: authorized }),
      ],
      installLegacyPorts: false,
    });
    expect(report.ok).toBe(true);

    const gateway = kernel.registry.resolve(OutboundGatewayToken);
    const spy = vi.spyOn(gateway, "handleCommand").mockResolvedValue({ accepted: true });

    recording.emitCommand({
      raw: { schemaVersion: 1, type: "ping", requestId: "r1" },
      principal: { principalId: "intruder" },
      conversationId: "conv-1",
      connectionId: "c1",
    });
    expect(spy).not.toHaveBeenCalled();

    recording.emitCommand({
      raw: { schemaVersion: 1, type: "ping", requestId: "r2" },
      principal: { principalId: "local" },
      conversationId: "conv-1",
      connectionId: "c1",
    });
    expect(spy).toHaveBeenCalledTimes(1);

    await kernel.dispose();
  });

  it("生产装配默认携带本地主体授权：合法命令流到网关，伪造主体被拒", async () => {
    const recording = recordingTransport();
    const { kernel, report } = await createAikaKernel({
      hostPlugins: [
        ...testHostPlugins({ storage: await realStorage() }),
        outboundTransportPlugin(recording.transport),
      ],
      // 不覆盖 featurePlugins：锁的就是 capabilityPlugins() 的生产默认值——
      // 装配自带 LOCAL_PRINCIPAL_ID 核验，命令入口在生产装配下是接通的；
      // Rust 宿主 emit 的命令（principalId 恒为 "local"）因此能到达网关。
      installLegacyPorts: false,
    });
    expect(report.ok).toBe(true);

    const gateway = kernel.registry.resolve(OutboundGatewayToken);
    const spy = vi.spyOn(gateway, "handleCommand").mockResolvedValue({ accepted: true });

    recording.emitCommand({
      raw: { schemaVersion: 1, type: "ping", requestId: "r1" },
      principal: { principalId: "intruder" },
      conversationId: "conv-1",
      connectionId: "c1",
    });
    expect(spy).not.toHaveBeenCalled();

    recording.emitCommand({
      raw: { schemaVersion: 1, type: "ping", requestId: "r2" },
      principal: { principalId: "local" },
      conversationId: "conv-1",
      connectionId: "c1",
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0].principal.principalId).toBe("local");

    await kernel.dispose();
  });
});

describe("FE-17-host gatewayEpoch 来自宿主存活状态", () => {
  it("装配的生命周期 epoch 就是网关的 gatewayEpoch", async () => {
    const lifecycle = createHostLifecycle({ epoch: "host-epoch-42" });
    const recording = recordingTransport();
    const { kernel } = await createAikaKernel({
      hostPlugins: [
        ...testHostPlugins({ storage: await realStorage(), hostLifecycle: lifecycle }),
        outboundTransportPlugin(recording.transport),
      ],
      installLegacyPorts: false,
    });

    expect(kernel.registry.resolve(HostLifecycleToken)).toBe(lifecycle);

    const gateway = kernel.registry.resolve(OutboundGatewayToken);
    gateway.registerTarget("t1", { connectionId: "c1", conversationId: "conv-1", principalId: "local" });
    gateway.handleRuntimeEvent({
      turnId: "t1", seq: 1, type: "state", state: "generating",
    } as never);

    expect(recording.published).toHaveLength(1);
    expect(recording.published[0].frame.cursor.gatewayEpoch).toBe("host-epoch-42");

    await kernel.dispose();
  });

  it("宿主存活状态插件自带 dispose：内核释放时生命周期也释放", async () => {
    const lifecycle = createHostLifecycle();
    const dispose = vi.spyOn(lifecycle, "dispose");
    const plugin: AikaPlugin = hostLifecyclePlugin(lifecycle);

    const { kernel } = await createAikaKernel({
      hostPlugins: [
        ...testHostPlugins({ storage: await realStorage() }).filter((p) => p.id !== "host.lifecycle"),
        plugin,
      ],
      installLegacyPorts: false,
    });
    kernel.registry.resolve(HostLifecycleToken);
    await kernel.dispose();

    expect(dispose).toHaveBeenCalled();
  });
});

describe("FE-17-host 装配单元：createOutboundPluginGateway", () => {
  it("命令经网关落到 Runtime 的 submit，且帧只发给登记的会话", async () => {
    const submitted: Array<{ text: string; conversationId?: string; principalId?: string }> = [];
    const runtime = {
      submit: (request: { text: string; conversation?: { conversationId: string; principalId: string } }) => {
        submitted.push({
          text: request.text,
          conversationId: request.conversation?.conversationId,
          principalId: request.conversation?.principalId,
        });
        return { turnId: "turn-1", done: Promise.resolve({ state: "completed" as const, persisted: true }) };
      },
      cancel: () => undefined,
      subscribe: () => () => undefined,
    } as unknown as CompanionRuntime;

    const recording = recordingTransport();
    const { gateway, dispose } = createOutboundPluginGateway({
      runtime,
      gatewayEpoch: "e1",
      transport: recording.transport,
      commandAuthorizer: () => true,
    });

    recording.emitCommand({
      raw: { schemaVersion: 1, type: "submit", messageId: "m1", text: "你好" },
      principal: { principalId: "local" },
      conversationId: "conv-9",
      connectionId: "c9",
    });

    // handleCommand 里 submit 是同步调用（返回的 Promise 由调用方 void 掉）。
    await Promise.resolve();
    expect(submitted).toEqual([{ text: "你好", conversationId: "conv-9", principalId: "local" }]);

    // 映射已登记：这一轮的帧只发给这条连接。
    gateway.handleRuntimeEvent({
      turnId: "turn-1", seq: 1, type: "generated",
      reply: { replyText: "在", translation: null, mood: "neutral", actions: [] },
    } as never);
    expect(recording.published).toHaveLength(1);
    expect(recording.published[0].conversationId).toBe("conv-9");

    dispose();
  });

  it("dispose 会退订 Runtime：subscribe 返回的退订函数被调用", async () => {
    const unsubscribe = vi.fn();
    const runtime = {
      submit: () => ({ turnId: "t", done: Promise.resolve({ state: "completed" as const, persisted: true }) }),
      cancel: () => undefined,
      subscribe: () => unsubscribe,
    } as unknown as CompanionRuntime;

    const { dispose } = createOutboundPluginGateway({ runtime, gatewayEpoch: "e1" });
    expect(unsubscribe).not.toHaveBeenCalled();
    dispose();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("没有宿主存活状态时：gatewayEpoch 退化为装配时给定的 fallbackEpoch", async () => {
    const recording = recordingTransport();
    // 剔除 host.lifecycle，模拟「宿主没提供存活状态」这一路径。
    const hostPlugins = testHostPlugins({ storage: await realStorage() })
      .filter((plugin) => plugin.id !== "host.lifecycle");
    const { kernel, report } = await createAikaKernel({
      hostPlugins: [...hostPlugins, outboundTransportPlugin(recording.transport)],
      featurePlugins: [
        ...capabilityPlugins().filter((plugin) => plugin.id !== "outbound.core"),
        outboundPlugin({ fallbackEpoch: "fallback-1" }),
      ],
      installLegacyPorts: false,
    });

    expect(report.ok).toBe(true);
    expect(kernel.registry.has(HostLifecycleToken)).toBe(false);

    const gateway = kernel.registry.resolve(OutboundGatewayToken);
    gateway.registerTarget("t1", { connectionId: "c1", conversationId: "conv-1", principalId: "local" });
    gateway.handleRuntimeEvent({ turnId: "t1", seq: 1, type: "state", state: "generating" } as never);

    expect(recording.published[0].frame.cursor.gatewayEpoch).toBe("fallback-1");

    await kernel.dispose();
  });
});
