/**
 * Device Gateway：设备记录、能力协商、租约与重连（GW-04）。
 *
 * 配对码/会话/撤销归 FE-17-pre 的凭证仓库——这里只加**设备记录/列表/能力
 * 协商/心跳与重连体验**，不造第二套配对码。
 *
 * - capability = 服务端授权 ∩ 设备声明，逐项可见降级（协议枚举存在≠能力存在）。
 * - 在线状态是租约读时计算（心跳新鲜度），不是存储的布尔。
 * - 重连必须带 cursor：epoch 变了或 cursor 过旧 → 明确要求 resync，
 *   **离线期间不本地调用 LLM、不自动重放状态未知的指令**。
 * - 设备身份是 deviceId，不是设备名或 IP。
 */

import type { OutboundCursor } from "../outbound/contracts";

export type DeviceCapability = "chat" | "voice_input" | "voice_output" | "notification";

export const DEVICE_LEASE_MS = 30_000;

export interface DeviceRecordV1 {
  deviceId: string;
  label: string;
  principalId: string;
  /** 服务端授权 ∩ 设备声明后的最终能力。 */
  capabilities: readonly DeviceCapability[];
  declaredCapabilities: readonly DeviceCapability[];
  lastHeartbeatAt: number;
  registeredAt: number;
}

export interface DeviceRegistryOptions {
  /** 服务端按主体授权的能力上限（能力交集的服务端一侧）。 */
  serverAllowedCapabilities: (principalId: string) => readonly DeviceCapability[];
  /** Trace 外发/审批提交永远不走设备能力枚举——独立授权口，默认拒绝。 */
  clock?: () => number;
  leaseMs?: number;
  /** 当前网关 epoch（重连比对）。 */
  gatewayEpoch: () => string;
  /** 事件缓存中仍保留的最旧 seq；不提供则不做 cursor 过旧判定（由 events 端口报 gap）。 */
  oldestRetainedSeq?: () => number;
}

export interface DeviceRegistry {
  registerDevice(input: {
    deviceId: string;
    label: string;
    principalId: string;
    declaredCapabilities: readonly DeviceCapability[];
  }): DeviceRecordV1;
  heartbeat(deviceId: string): { ok: boolean; reason?: "unknown-device" };
  /** 租约读时计算：lease 内 online，否则 offline。 */
  list(principalId?: string): Array<DeviceRecordV1 & { online: boolean }>;
  capabilitiesFor(deviceId: string): { ok: true; capabilities: readonly DeviceCapability[]; online: boolean } | { ok: false; reason: "unknown-device" };
  /** 动作授权：chat 走能力交集；trace/approval 是独立授权口（默认拒绝）。 */
  authorize(deviceId: string, action: "chat" | "trace" | "approval" | "notification"): { ok: boolean; reason?: "unknown-device" | "offline" | "capability-missing" | "not-authorized" };
  /** 重连：epoch 变化或 cursor 过旧 → resync。 */
  reconnect(input: { deviceId: string; cursor: OutboundCursor }): { resync: boolean; reason?: "epoch-changed" | "cursor-too-old" | "unknown-device"; currentEpoch: string };
}

export function createDeviceRegistry(options: DeviceRegistryOptions): DeviceRegistry {
  const clock = options.clock ?? (() => Date.now());
  const leaseMs = Math.max(1_000, options.leaseMs ?? DEVICE_LEASE_MS);
  const devices = new Map<string, DeviceRecordV1>();

  function isOnline(record: DeviceRecordV1): boolean {
    return clock() - record.lastHeartbeatAt <= leaseMs;
  }

  return {
    registerDevice(input) {
      const serverAllowed = options.serverAllowedCapabilities(input.principalId);
      const declared = input.declaredCapabilities;
      // 能力交集：服务端授权与设备声明逐项取交，缺项可见降级。
      const capabilities = declared.filter((capability) => serverAllowed.includes(capability));
      const existing = devices.get(input.deviceId);
      const record: DeviceRecordV1 = {
        deviceId: input.deviceId,
        label: input.label,
        principalId: input.principalId,
        declaredCapabilities: [...declared],
        capabilities,
        lastHeartbeatAt: existing?.lastHeartbeatAt ?? clock(),
        registeredAt: existing?.registeredAt ?? clock(),
      };
      devices.set(input.deviceId, record);
      return record;
    },

    heartbeat(deviceId) {
      const record = devices.get(deviceId);
      if (!record) return { ok: false, reason: "unknown-device" };
      record.lastHeartbeatAt = clock();
      return { ok: true };
    },

    list(principalId) {
      return [...devices.values()]
        .filter((record) => !principalId || record.principalId === principalId)
        .map((record) => ({ ...record, online: isOnline(record) }));
    },

    capabilitiesFor(deviceId) {
      const record = devices.get(deviceId);
      if (!record) return { ok: false, reason: "unknown-device" };
      return { ok: true, capabilities: record.capabilities, online: isOnline(record) };
    },

    authorize(deviceId, action) {
      const record = devices.get(deviceId);
      if (!record) return { ok: false, reason: "unknown-device" };
      if (action !== "chat" && action !== "notification") {
        // trace/审批不在设备能力枚举里：必须有独立授权（FE-14 四门/RT-03），默认拒绝。
        return { ok: false, reason: "not-authorized" };
      }
      if (!isOnline(record)) return { ok: false, reason: "offline" };
      const needed: DeviceCapability = action === "chat" ? "chat" : "notification";
      if (!record.capabilities.includes(needed)) return { ok: false, reason: "capability-missing" };
      return { ok: true };
    },

    reconnect(input) {
      const record = devices.get(input.deviceId);
      const currentEpoch = options.gatewayEpoch();
      if (!record) return { resync: true, reason: "unknown-device", currentEpoch };
      // 心跳重置：重连即续租。
      record.lastHeartbeatAt = clock();
      if (input.cursor.gatewayEpoch !== currentEpoch) {
        return { resync: true, reason: "epoch-changed", currentEpoch };
      }
      const oldest = options.oldestRetainedSeq?.();
      if (oldest !== undefined && input.cursor.seq < oldest) {
        // 需要的帧已被缓存淘汰：明确 resync，不假装能从空洞续播。
        return { resync: true, reason: "cursor-too-old", currentEpoch };
      }
      return { resync: false, currentEpoch };
    },
  };
}
