import { describe, expect, it } from "vitest";
import type { OutboundCursor } from "../outbound/contracts";
import { createDeviceRegistry } from "./deviceRegistry";

const BASE = Date.UTC(2026, 0, 10, 12, 0);

function makeRegistry() {
  let now = BASE;
  const registry = createDeviceRegistry({
    serverAllowedCapabilities: (principalId) =>
      principalId === "ext-A" ? ["chat", "voice_output", "notification"] : ["chat"],
    clock: () => now,
    leaseMs: 30_000,
    gatewayEpoch: () => "epoch-current",
    oldestRetainedSeq: () => 8,
  });
  return { registry, tick: (ms: number) => { now += ms; } };
}

function cursor(epoch = "epoch-current", seq = 10): OutboundCursor {
  return { gatewayEpoch: epoch, seq };
}

describe("Device Gateway（GW-04）", () => {
  it("能力协商：服务端授权 ∩ 设备声明，缺项可见降级（GW-04-C）", () => {
    const { registry } = makeRegistry();
    // 设备声明 4 项，服务端只授权 3 项 → 交集 3 项。
    const record = registry.registerDevice({
      deviceId: "dev-1", label: "我的手机", principalId: "ext-A",
      declaredCapabilities: ["chat", "voice_input", "voice_output", "notification"],
    });
    expect(record.capabilities).toEqual(["chat", "voice_output", "notification"]);

    const caps = registry.capabilitiesFor("dev-1");
    expect(caps.ok && caps.capabilities.includes("voice_input")).toBe(false);
  });

  it("租约：心跳内 online，超时 offline；心跳续租（GW-04-B）", () => {
    const { registry, tick } = makeRegistry();
    registry.registerDevice({
      deviceId: "dev-1", label: "手机", principalId: "ext-A",
      declaredCapabilities: ["chat"],
    });
    expect(registry.list()[0].online).toBe(true);

    tick(31_000);
    expect(registry.list()[0].online).toBe(false);
    // 离线设备不可用 chat（PC 离线显示不可用，不生成第二份回复的设备侧依据）。
    expect(registry.authorize("dev-1", "chat")).toEqual({ ok: false, reason: "offline" });

    registry.heartbeat("dev-1");
    expect(registry.list()[0].online).toBe(true);
  });

  it("重连：epoch 变化与 cursor 过旧都明确 resync（GW-04-B）", () => {
    const { registry } = makeRegistry();
    registry.registerDevice({ deviceId: "dev-1", label: "手机", principalId: "ext-A", declaredCapabilities: ["chat"] });

    // cursor seq 10 在缓存窗口（最旧 8）内：正常续播。
    expect(registry.reconnect({ deviceId: "dev-1", cursor: cursor("epoch-current", 10) }))
      .toEqual({ resync: false, currentEpoch: "epoch-current" });
    // epoch 变了：resync。
    expect(registry.reconnect({ deviceId: "dev-1", cursor: cursor("epoch-old", 10) }))
      .toEqual({ resync: true, reason: "epoch-changed", currentEpoch: "epoch-current" });
    // cursor 低于缓存最旧 seq：明确 resync，不假装能从空洞续播。
    expect(registry.reconnect({ deviceId: "dev-1", cursor: cursor("epoch-current", 3) }))
      .toEqual({ resync: true, reason: "cursor-too-old", currentEpoch: "epoch-current" });
  });

  it("trace/审批不在设备能力枚举：默认 not-authorized（GW-04-C）", () => {
    const { registry } = makeRegistry();
    registry.registerDevice({ deviceId: "dev-1", label: "手机", principalId: "ext-A", declaredCapabilities: ["chat"] });
    expect(registry.authorize("dev-1", "trace")).toEqual({ ok: false, reason: "not-authorized" });
    expect(registry.authorize("dev-1", "approval")).toEqual({ ok: false, reason: "not-authorized" });
    expect(registry.authorize("dev-1", "chat")).toEqual({ ok: true });
  });

  it("逐设备隔离：撤销/移除设备不影响其他设备（GW-04-A）", () => {
    const { registry } = makeRegistry();
    registry.registerDevice({ deviceId: "dev-1", label: "A", principalId: "ext-A", declaredCapabilities: ["chat"] });
    registry.registerDevice({ deviceId: "dev-2", label: "B", principalId: "ext-A", declaredCapabilities: ["chat"] });

    registry.heartbeat("dev-1");
    registry.heartbeat("dev-2");
    // 模拟逐设备撤销：只删 dev-1 的记录。
    registry.registerDevice({
      deviceId: "dev-2", label: "B", principalId: "ext-A", declaredCapabilities: ["chat"],
    });
    expect(registry.list("ext-A").map((device) => device.deviceId).sort()).toEqual(["dev-1", "dev-2"]);
    expect(registry.authorize("dev-2", "chat").ok).toBe(true);
  });
});
