import { ManagementError } from '../contracts/management.js';
import type { PairingScope } from '../contracts/character-pack.js';
import type { ProactiveInvitationPolicy, ProactiveInvitationRuntime } from '../companion/proactive-invitation-runtime.js';

export interface ProactiveInvitationManagement {
  policy(pairing: PairingScope): ProactiveInvitationPolicy;
  configure(pairing: PairingScope, expectedRevision: number, policy: Omit<ProactiveInvitationPolicy, 'revision'>): ProactiveInvitationPolicy;
}

export function proactiveInvitationManagement(runtime: ProactiveInvitationRuntime,
  onChange?: (pairing: PairingScope, policy: ProactiveInvitationPolicy, previouslyShown: import('../contracts/index.js').ProactiveInvitation | null) => void): ProactiveInvitationManagement {
  return {
    policy: pairing => runtime.policy(pairing),
    configure(pairing, expectedRevision, policy) {
      try {
        const previouslyShown = runtime.shown(pairing);
        const saved = runtime.configure(pairing, expectedRevision, policy);
        try { onChange?.(pairing, saved, previouslyShown); } catch { /* The persisted policy is authoritative; the next renderer presence retries. */ }
        return saved;
      } catch (error) {
        if (error instanceof Error && error.message === 'proactive_policy_revision_conflict') throw new ManagementError('version_conflict', '主动陪伴设置已变化，请刷新后重试。');
        if (error instanceof Error && error.message === 'invalid_proactive_policy') throw new ManagementError('invalid_request', '主动陪伴设置无效或超过共享邀请限额。');
        throw new ManagementError('internal_error', '主动陪伴设置未保存。');
      }
    },
  };
}

const required = (value: unknown, name: string, max = 128): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new ManagementError('invalid_request', `${name} 无效。`);
  return value;
};
const pair = (value: unknown): PairingScope => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ManagementError('invalid_request', '角色配对无效。');
  const raw = value as Record<string, unknown>;
  return { userId: required(raw.userId, 'userId'), characterId: required(raw.characterId, 'characterId'),
    characterInstanceId: required(raw.characterInstanceId, 'characterInstanceId') };
};
const integer = (value: unknown, name: string, min = 0): number => {
  if (!Number.isSafeInteger(value) || Number(value) < min) throw new ManagementError('invalid_request', `${name} 无效。`);
  return Number(value);
};

export async function proactiveInvitationRoute(method: string | undefined, port: ProactiveInvitationManagement | undefined,
  pathname: string, body: () => Promise<Record<string, unknown>>): Promise<unknown> {
  if (!port) throw new ManagementError('unavailable', '当前运行实例未启用主动陪伴管理。');
  if (pathname !== '/api/proactive/policy') throw new ManagementError('not_found', '没有这个主动陪伴操作。');
  if (method !== 'POST' && method !== 'PUT') throw new ManagementError('not_found', '没有这个主动陪伴操作。');
  const payload = await body();
  const pairing = pair(payload.pairing);
  if (method === 'POST') return { policy: port.policy(pairing) };
  const raw = payload.policy;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ManagementError('invalid_request', '主动陪伴设置无效。');
  const value = raw as Record<string, unknown>;
  if (typeof value.enabled !== 'boolean' || !Array.isArray(value.sourceKinds)) throw new ManagementError('invalid_request', '主动陪伴设置无效。');
  const policy: Omit<ProactiveInvitationPolicy, 'revision'> = {
    enabled: value.enabled,
    dailyMax: integer(value.dailyMax, 'dailyMax'),
    minIntervalMs: integer(value.minIntervalMs, 'minIntervalMs'),
    timezone: required(value.timezone, 'timezone', 80),
    dndStartHour: integer(value.dndStartHour, 'dndStartHour'),
    dndEndHour: integer(value.dndEndHour, 'dndEndHour'),
    sourceKinds: Object.freeze(value.sourceKinds.map(source => required(source, 'sourceKind', 32)) as ['continuity_fact']),
  };
  return { policy: port.configure(pairing, integer(payload.expectedRevision, 'expectedRevision'), policy) };
}
