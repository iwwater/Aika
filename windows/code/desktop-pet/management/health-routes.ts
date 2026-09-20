// FIX61-07: health and microphone routes.
//
// Health is read-only and derived from in-process observations; there is no paid probe and no timer that
// lights a lamp. The microphone routes operate on the DESKTOP renderer (which owns the device), so the
// console only stores the machine-local preference — it never opens a capture on the user's behalf.
import { ManagementError } from '../contracts/management.js';
import type { HealthSnapshot } from '../core/health-snapshot.js';
import type { MicrophonePreferenceStore } from '../media/microphone-test.js';

export interface HealthManagement {
  snapshot(): HealthSnapshot;
  /** Repair entry point for one light. */
  repair(module: string): { reasonCode: string | null; repairAction: string | null };
}
export function healthManagement(registry: { snapshot(at?: number): HealthSnapshot; repair(module: string): { reasonCode: string | null; repairAction: string | null } }): HealthManagement {
  return { snapshot: () => registry.snapshot(), repair: module => registry.repair(module) };
}

export interface MicrophoneManagement {
  preference(): Promise<{ deviceId: string | null }>;
  save(deviceId: string | null): Promise<{ deviceId: string | null }>;
}
export function microphoneManagement(store: MicrophonePreferenceStore): MicrophoneManagement {
  return {
    preference: async () => ({ deviceId: store.deviceId() }),
    save: async deviceId => {
      if (deviceId !== null && (typeof deviceId !== 'string' || !deviceId.trim() || deviceId.length > 512)) throw new ManagementError('invalid_request', '麦克风设备标识无效。');
      await store.save(deviceId);
      return { deviceId: store.deviceId() };
    }
  };
}

const text = (value: unknown, max: number): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new ManagementError('invalid_request', '字段无效。');
  return value;
};

export async function healthRoute(method: string | undefined, health: HealthManagement | undefined, pathname: string): Promise<unknown> {
  if (!health) throw new ManagementError('unavailable', '当前版本尚未接入模块状态。');
  if (method !== 'GET') throw new ManagementError('not_found', '模块状态只读。');
  if (pathname === '/api/health') return health.snapshot();
  const match = /^\/api\/health\/([A-Za-z0-9_]{1,40})$/.exec(pathname);
  if (!match) throw new ManagementError('not_found', '没有这个状态接口。');
  const snapshot = health.snapshot(), module = snapshot.modules[match[1]!];
  if (!module) throw new ManagementError('not_found', '没有这个模块。');
  return { ...module, ...health.repair(match[1]!) };
}

export async function microphoneRoute(method: string | undefined, microphone: MicrophoneManagement | undefined, pathname: string, body: () => Promise<Record<string, unknown>>): Promise<unknown> {
  if (!microphone) throw new ManagementError('unavailable', '当前版本尚未接入麦克风偏好。');
  if (pathname !== '/api/microphone/preference') throw new ManagementError('not_found', '没有这个麦克风接口。');
  if (method === 'GET') return microphone.preference();
  if (method === 'PUT') {
    const payload = await body();
    const raw = payload.deviceId;
    // null is an explicit "use the system default device", distinct from a missing field.
    if (raw !== null && typeof raw !== 'string') throw new ManagementError('invalid_request', 'deviceId 必须是字符串或 null。');
    return microphone.save(raw === null ? null : text(raw, 512));
  }
  throw new ManagementError('not_found', '没有这个麦克风操作。');
}
