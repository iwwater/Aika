import { randomUUID } from 'node:crypto';
import type { PairingScope } from '../contracts/character-pack.js';
import type { CaptureGrant, GrantScopeType, Observation } from '../contracts/perception.js';
import type { CaptureGrantManager } from '../core/perception-grant.js';
import type { ScreenPerceptionService } from '../core/screen-perception.js';
import type { ObservationTurnInbox } from '../core/observation-context.js';

const MAX_FRAME_BYTES = 1_500_000;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Runtime capability exposed only through the authenticated, same-origin management API. */
export class PerceptionManagementRuntime {
  constructor(
    private readonly grants: CaptureGrantManager,
    private readonly service: ScreenPerceptionService,
    private readonly inbox: ObservationTurnInbox,
    private readonly pairing: PairingScope,
    private readonly sessionId: string,
    private readonly capabilities: { readonly local: boolean; readonly cloud: boolean },
  ) {}

  status() {
    return { enabled: true, pairing: this.pairing, capabilities: { ...this.capabilities },
      activeGrants: this.grants.listActiveGrants().filter(grant => grant.sessionId === this.sessionId),
      instruction: '每次采集均需通过系统来源选择、预览和明确确认；云端处理按单帧授权。' };
  }

  issue(input: { scopeType: GrantScopeType; destination: 'local' | 'cloud'; userConfirmed: boolean }): CaptureGrant {
    if (input.userConfirmed !== true) throw new Error('capture_confirmation_required');
    if (!['window', 'region', 'screen'].includes(input.scopeType)) throw new Error('capture_scope_invalid');
    if (input.destination !== 'local' && input.destination !== 'cloud') throw new Error('capture_destination_invalid');
    if (!this.capabilities[input.destination]) throw new Error(`${input.destination}_perception_engine_unavailable`);
    return this.grants.issueGrant({ sessionId: this.sessionId, scopeType: input.scopeType,
      targetId: `selected-${randomUUID()}`, purpose: '用户明确请求的当前屏幕问答', destination: input.destination,
      duration: 'single', ttlMs: 60_000 });
  }

  async capture(input: { grantId: string; mimeType: string; imageBase64: string }): Promise<Observation> {
    if (typeof input.grantId !== 'string' || !/^grant-[0-9a-f-]{36}$/i.test(input.grantId)) throw new Error('capture_grant_invalid');
    if (input.mimeType !== 'image/png' && input.mimeType !== 'image/jpeg') throw new Error('capture_frame_type_invalid');
    if (typeof input.imageBase64 !== 'string' || !input.imageBase64 || input.imageBase64.length > Math.ceil(MAX_FRAME_BYTES * 4 / 3) + 4
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.imageBase64)) {
      throw new Error('capture_frame_encoding_invalid');
    }
    const bytes = Buffer.from(input.imageBase64, 'base64');
    try {
      if (!bytes.length || bytes.byteLength > MAX_FRAME_BYTES || bytes.toString('base64') !== input.imageBase64) throw new Error('capture_frame_size_invalid');
      const validPng = input.mimeType === 'image/png' && bytes.length >= PNG_SIGNATURE.length && bytes.subarray(0, 8).equals(PNG_SIGNATURE);
      const validJpeg = input.mimeType === 'image/jpeg' && bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
      if (!validPng && !validJpeg) throw new Error('capture_frame_signature_invalid');
      return await this.service.processCapture({ grantId: input.grantId, imageBytes: bytes, mimeType: input.mimeType }, this.pairing);
    } finally {
      bytes.fill(0);
      input.imageBase64 = '';
    }
  }

  attach(observationId: string, userConfirmed: boolean): void {
    if (userConfirmed !== true) throw new Error('observation_attach_confirmation_required');
    this.inbox.attach(observationId, this.pairing);
  }

  revoke(grantId: string): { revoked: boolean } { return { revoked: this.grants.revokeGrant(grantId) }; }

  clear(observationId: string): { cleared: true } {
    const observation = this.service.getObservation(observationId);
    if (observation && (observation.pairing.userId !== this.pairing.userId
      || observation.pairing.characterId !== this.pairing.characterId
      || observation.pairing.characterInstanceId !== this.pairing.characterInstanceId)) throw new Error('observation_not_active_for_pairing');
    this.inbox.clear(this.pairing);
    this.service.invalidateObservation(observationId);
    return { cleared: true };
  }

  close(): void {
    this.inbox.clear(this.pairing);
    for (const grant of this.grants.listActiveGrants()) if (grant.sessionId === this.sessionId) this.grants.revokeGrant(grant.grantId);
    this.service.close();
  }
}
