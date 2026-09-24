// N07-05: local-session management boundary for User Soul/Wiki and relationship facts.
// The HTTP layer validates shape and delegates all revision/forget semantics to the memory owner.
import { ManagementError } from '../contracts/management.js';
import type { ContinuityMemoryPort, ContinuityRecordInput, ContinuityCorrectionInput, ContinuityForgetInput } from '../contracts/continuity-memory.js';
import type { PairingScope } from '../contracts/character-pack.js';

export interface ContinuityManagement {
  snapshot(pairing: PairingScope, includeCandidates?: boolean): ReturnType<ContinuityMemoryPort['snapshot']>;
  record(input: ContinuityRecordInput): ReturnType<ContinuityMemoryPort['record']>;
  promote(pairing: PairingScope, operationId: string, targetId: string, expectedVersion: number): ReturnType<ContinuityMemoryPort['promote']>;
  correct(input: ContinuityCorrectionInput): ReturnType<ContinuityMemoryPort['correct']>;
  forget(input: ContinuityForgetInput): ReturnType<ContinuityMemoryPort['forget']>;
}

const safe = <T>(work: () => T): T => {
  try { return work(); }
  catch (error) {
    if (error instanceof ManagementError) throw error;
    const code = (error as { code?: string }).code;
    if (code === 'version_conflict') throw new ManagementError('version_conflict', '连续性内容已变化或已撤销，请刷新后重试。');
    if (code === 'not_found') throw new ManagementError('not_found', '连续性条目不存在。');
    if (code === 'forbidden') throw new ManagementError('forbidden', '该内容不能作为用户事实保存。');
    if (code === 'invalid_request') throw new ManagementError('invalid_request', '连续性请求无效。');
    throw new ManagementError('internal_error', '连续性操作未完成，原始内容未对外输出。');
  }
};

export function continuityManagement(store: ContinuityMemoryPort, afterMutation?: (pairing: PairingScope) => void): ContinuityManagement {
  const changed = (pairing: PairingScope) => { try { afterMutation?.(pairing); } catch { /* Revision cursors recover committed facts after restart. */ } };
  return {
    snapshot: (pairing, includeCandidates = false) => safe(() => store.snapshot(pairing, { includeCandidates })),
    record: input => safe(() => { const result = store.record(input); changed(input.pairing); return result; }),
    promote: (pairing, operationId, targetId, expectedVersion) => safe(() => { const result = store.promote(pairing, operationId, targetId, expectedVersion); changed(pairing); return result; }),
    correct: input => safe(() => { const result = store.correct(input); changed(input.pairing); return result; }),
    forget: input => safe(() => { const result = store.forget(input); changed(input.pairing); return result; }),
  };
}

const text = (value: unknown, max = 16000): string => {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw new ManagementError('invalid_request', '文本字段无效。');
  return value;
};
const requiredText = (value: unknown, name: string, max = 256): string => { const result = text(value, max); if (!result.trim()) throw new ManagementError('invalid_request', `${name} 不能为空。`); return result; };
const integer = (value: unknown, name: string, min = 0): number => { const n = Number(value); if (!Number.isSafeInteger(n) || n < min) throw new ManagementError('invalid_request', `${name} 无效。`); return n; };
function pairing(value: unknown): PairingScope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ManagementError('invalid_request', '配对标识无效。');
  const raw = value as Record<string, unknown>;
  return { userId: requiredText(raw.userId, 'userId'), characterId: requiredText(raw.characterId, 'characterId'), characterInstanceId: requiredText(raw.characterInstanceId, 'characterInstanceId') };
}
function sourceIds(value: unknown): readonly string[] { if (value === undefined) return []; if (!Array.isArray(value)) throw new ManagementError('invalid_request', 'sourceIds 无效。'); return Object.freeze(value.map(item => requiredText(item, 'sourceId', 256))); }

/** /api/continuity/* — same local-session authorization as the other management routes. */
export function continuityRoute(method: string | undefined, port: ContinuityManagement | undefined, pathname: string, body: () => Promise<Record<string, unknown>>): Promise<unknown> | unknown {
  if (!port) throw new ManagementError('unavailable', '当前版本尚未接入连续性管理。');
  if (pathname === '/api/continuity/snapshot') {
    if (method !== 'POST') throw new ManagementError('not_found', '没有这个连续性操作。');
    return body().then(payload => port.snapshot(pairing(payload.pairing), payload.includeCandidates === true));
  }
  if (pathname === '/api/continuity/record') {
    if (method !== 'POST') throw new ManagementError('not_found', '没有这个连续性操作。');
    return body().then(payload => {
      let input: ContinuityRecordInput = { pairing: pairing(payload.pairing), operationId: requiredText(payload.operationId, 'operationId', 160), layer: requiredText(payload.layer, 'layer', 32) as ContinuityRecordInput['layer'], kind: requiredText(payload.kind, 'kind', 32) as ContinuityRecordInput['kind'], text: requiredText(payload.text, 'text'), sourceIds: sourceIds(payload.sourceIds), origin: requiredText(payload.origin, 'origin', 32) as ContinuityRecordInput['origin'] };
      if (payload.status !== undefined) input = { ...input, status: requiredText(payload.status, 'status', 16) as NonNullable<ContinuityRecordInput['status']> };
      if (payload.validFrom !== undefined) input = { ...input, validFrom: text(payload.validFrom, 80) };
      if (payload.validTo !== undefined) input = { ...input, validTo: text(payload.validTo, 80) };
      return port.record(input);
    });
  }
  if (pathname === '/api/continuity/promote') {
    if (method !== 'POST') throw new ManagementError('not_found', '没有这个连续性操作。');
    return body().then(payload => port.promote(pairing(payload.pairing), requiredText(payload.operationId, 'operationId', 160), requiredText(payload.targetId, 'targetId', 160), integer(payload.expectedVersion, 'expectedVersion', 1)));
  }
  if (pathname === '/api/continuity/correct') {
    if (method !== 'POST') throw new ManagementError('not_found', '没有这个连续性操作。');
    return body().then(payload => port.correct({ pairing: pairing(payload.pairing), operationId: requiredText(payload.operationId, 'operationId', 160), targetId: requiredText(payload.targetId, 'targetId', 160), expectedVersion: integer(payload.expectedVersion, 'expectedVersion', 1), text: requiredText(payload.text, 'text'), reason: requiredText(payload.reason, 'reason', 2000), sourceIds: sourceIds(payload.sourceIds) }));
  }
  if (pathname === '/api/continuity/forget') {
    if (method !== 'POST') throw new ManagementError('not_found', '没有这个连续性操作。');
    return body().then(payload => port.forget({ pairing: pairing(payload.pairing), operationId: requiredText(payload.operationId, 'operationId', 160), targetId: requiredText(payload.targetId, 'targetId', 160), expectedVersion: integer(payload.expectedVersion, 'expectedVersion', 1), reason: requiredText(payload.reason, 'reason', 2000) }));
  }
  throw new ManagementError('not_found', '没有这个连续性接口。');
}
