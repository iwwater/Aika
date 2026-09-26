/**
 * core/proactive-companion.ts
 *
 * 08-04: Proactive Companion & Arbitration Engine.
 * Governs proactive desktop invitations, do-not-disturb (DND), daily quotas,
 * cooldown intervals, user busy state arbitration, and source revocation.
 */

import { randomUUID } from 'node:crypto';
import type { CompanionEventHub } from './companion-event-hub.js';
import { isSamePairing } from './companion-event-hub.js';
import type {
  InvitationCandidate,
  InvitationActionKind,
  CompanionEventEnvelope,
} from '../contracts/perception.js';
import type { PairingScope } from '../contracts/character-pack.js';

export interface ProactivePolicy {
  readonly enabled: boolean;
  readonly dailyMax: number;
  readonly minIntervalMs: number;
  readonly timezone: string;
  readonly dndStartHour?: number | undefined;
  readonly dndEndHour?: number | undefined;
}

export interface UserBusyState {
  readonly isTyping?: boolean | undefined;
  readonly isSpeaking?: boolean | undefined;
  readonly isTurnActive?: boolean | undefined;
  readonly isWorkPendingConfirmation?: boolean | undefined;
}

export interface ArbitrationDecision {
  readonly canPresent: boolean;
  readonly reasonCode:
    | 'ok'
    | 'disabled'
    | 'user_busy'
    | 'dnd_active'
    | 'daily_quota_exceeded'
    | 'cooldown_active'
    | 'source_revoked'
    | 'no_candidates';
  readonly candidate?: InvitationCandidate | undefined;
}

export interface InvitationDeliveryRecord {
  readonly id: string;
  readonly pairing: PairingScope;
  readonly invitationId: string;
  readonly sourceKind: NonNullable<InvitationCandidate['sourceRef']>['kind'];
  readonly sourceId: string;
  readonly sourceVersion: number;
  readonly deliveredAtMs: number;
}

export interface InvitationActionResult {
  readonly action: InvitationActionKind;
  readonly text: string;
  readonly startVoice: boolean;
}

function pairingKey(p: PairingScope): string {
  return `${p.userId}:${p.characterId}:${p.characterInstanceId}`;
}

export class ProactiveCompanionService {
  private policyConfig: ProactivePolicy;
  private readonly candidates = new Map<string, InvitationCandidate>();
  private readonly deliveries: InvitationDeliveryRecord[] = [];
  private readonly revokedSources = new Set<string>();

  constructor(
    private readonly eventHub: CompanionEventHub,
    initialPolicy: ProactivePolicy,
    private readonly clock: () => string = () => new Date().toISOString(),
    private readonly isSourceValid: (sourceRef: InvitationCandidate['sourceRef']) => boolean,
  ) {
    this.policyConfig = { ...initialPolicy };
  }

  getPolicy(): ProactivePolicy {
    return { ...this.policyConfig };
  }

  updatePolicy(policy: Partial<ProactivePolicy>): void {
    this.policyConfig = { ...this.policyConfig, ...policy };
  }

  private getNowMs(): number {
    return new Date(this.clock()).getTime();
  }

  private getLocalParts(nowMs: number, timezone: string): { day: string; hour: number } {
    try {
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        hour12: false,
      });
      const parts = formatter.formatToParts(nowMs);
      const findPart = (t: string) => parts.find(p => p.type === t)?.value ?? '00';
      const day = `${findPart('year')}-${findPart('month')}-${findPart('day')}`;
      const hour = parseInt(findPart('hour'), 10);
      return { day, hour };
    } catch {
      const d = new Date(nowMs);
      return {
        day: d.toISOString().slice(0, 10),
        hour: d.getUTCHours(),
      };
    }
  }

  /**
   * Check if the current time falls within configured Do-Not-Disturb hours.
   */
  private isDndActive(nowMs: number): boolean {
    const { dndStartHour, dndEndHour, timezone } = this.policyConfig;
    if (dndStartHour === undefined || dndEndHour === undefined) return false;

    const { hour } = this.getLocalParts(nowMs, timezone);
    if (dndStartHour <= dndEndHour) {
      return hour >= dndStartHour && hour < dndEndHour;
    }
    // Overnight window (e.g. 23:00 to 07:00)
    return hour >= dndStartHour || hour < dndEndHour;
  }

  /**
   * Register a new invitation candidate into the pool.
   */
  registerCandidate(candidate: InvitationCandidate): void {
    if (!candidate.id.trim() || !candidate.text.trim() || !candidate.sourceRef?.id.trim() ||
      !Number.isSafeInteger(candidate.sourceRef.version) || candidate.sourceRef.version < 1 ||
      !Number.isFinite(Date.parse(candidate.createdAt)) || !Number.isFinite(Date.parse(candidate.validUntil)) ||
      Date.parse(candidate.validUntil) <= Date.parse(candidate.createdAt)) {
      throw new Error('invalid_invitation_candidate');
    }
    const current = this.candidates.get(candidate.id);
    if (current && (!isSamePairing(current.pairing, candidate.pairing) ||
      current.sourceRef.kind !== candidate.sourceRef.kind || current.sourceRef.id !== candidate.sourceRef.id ||
      current.sourceRef.version !== candidate.sourceRef.version)) {
      throw new Error('invitation_id_conflict');
    }
    // Registration/replay is idempotent. Never reset a delivered or terminal candidate.
    if (current) return;

    // If source is already known as revoked, reject registration immediately
    if (this.revokedSources.has(candidate.sourceRef.id)) {
      this.#expireCandidate(candidate);
      return;
    }

    this.candidates.set(candidate.id, candidate);
  }

  /**
   * Revoke all candidates associated with a specific source ID (e.g. when an Observation is deleted).
   */
  revokeBySource(sourceId: string): number {
    this.revokedSources.add(sourceId);
    let revokedCount = 0;
    const nowIso = this.clock();

    for (const [id, cand] of this.candidates.entries()) {
      if (cand.sourceRef?.id === sourceId && cand.status !== 'expired') {
        const updated: InvitationCandidate = {
          ...cand,
          status: 'expired',
        };
        this.candidates.set(id, updated);
        revokedCount++;

        this.publishAudit('companion.invitation.expired', updated, nowIso);
      }
    }
    return revokedCount;
  }

  /**
   * Evaluate whether an invitation can be presented for the specified pairing.
   */
  evaluateArbitration(pairing: PairingScope, busyState: UserBusyState = {}): ArbitrationDecision {
    if (!this.policyConfig.enabled) {
      return { canPresent: false, reasonCode: 'disabled' };
    }

    // 1. User busy check (typing, speaking, thinking, active turn, work confirmation)
    if (
      busyState.isTyping ||
      busyState.isSpeaking ||
      busyState.isTurnActive ||
      busyState.isWorkPendingConfirmation
    ) {
      return { canPresent: false, reasonCode: 'user_busy' };
    }

    const nowMs = this.getNowMs();

    // 2. DND window check
    if (this.isDndActive(nowMs)) {
      return { canPresent: false, reasonCode: 'dnd_active' };
    }

    const currentKey = pairingKey(pairing);
    const { day } = this.getLocalParts(nowMs, this.policyConfig.timezone);

    // 3. Daily quota check
    const deliveriesToday = this.deliveries.filter(d => {
      if (pairingKey(d.pairing) !== currentKey) return false;
      const recordDay = this.getLocalParts(d.deliveredAtMs, this.policyConfig.timezone).day;
      return recordDay === day;
    });

    if (deliveriesToday.length >= this.policyConfig.dailyMax) {
      return { canPresent: false, reasonCode: 'daily_quota_exceeded' };
    }

    // 4. Cooldown check
    const lastDelivery = this.deliveries
      .filter(d => pairingKey(d.pairing) === currentKey)
      .sort((a, b) => b.deliveredAtMs - a.deliveredAtMs)[0];

    if (lastDelivery && nowMs - lastDelivery.deliveredAtMs < this.policyConfig.minIntervalMs) {
      return { canPresent: false, reasonCode: 'cooldown_active' };
    }

    // 5. Candidate selection & source validity
    const eligibleCandidates = Array.from(this.candidates.values())
      .filter(
        c =>
          isSamePairing(c.pairing, pairing) &&
          c.status === 'pending' &&
          !this.deliveries.some(d => d.invitationId === c.id),
      )
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

    for (const cand of eligibleCandidates) {
      // Check expiration
      if (new Date(cand.validUntil).getTime() <= nowMs) {
        this.#expireCandidate(cand);
        continue;
      }

      // Check revoked source
      if (this.revokedSources.has(cand.sourceRef.id)) {
        this.#expireCandidate(cand);
        continue;
      }

      // The active source must still exist at arbitration time.
      if (!this.#sourceIsValid(cand)) {
        this.#expireCandidate(cand);
        continue;
      }

      // Check duplicate replay: same source ID already delivered today
      const alreadyDelivered = deliveriesToday.some(d => d.sourceKind === cand.sourceRef.kind &&
        d.sourceId === cand.sourceRef.id && d.sourceVersion === cand.sourceRef.version);
      if (alreadyDelivered) {
        this.#expireCandidate(cand);
        continue;
      }

      return {
        canPresent: true,
        reasonCode: 'ok',
        candidate: cand,
      };
    }

    return { canPresent: false, reasonCode: 'no_candidates' };
  }

  /**
   * Present the next eligible invitation if arbitration permits.
   */
  presentNext(pairing: PairingScope, busyState: UserBusyState = {}): InvitationCandidate | null {
    const decision = this.evaluateArbitration(pairing, busyState);
    if (!decision.canPresent || !decision.candidate) {
      return null;
    }

    const cand = decision.candidate;
    const nowMs = this.getNowMs();
    const nowIso = this.clock();

    const shownCandidate: InvitationCandidate = {
      ...cand,
      status: 'pending', // stays in presentation/pending until accepted or dismissed
    };
    this.candidates.set(cand.id, shownCandidate);

    // Record delivery
    const deliveryRecord: InvitationDeliveryRecord = {
      id: `del-${randomUUID()}`,
      pairing,
      invitationId: cand.id,
      sourceKind: cand.sourceRef.kind,
      sourceId: cand.sourceRef.id,
      sourceVersion: cand.sourceRef.version,
      deliveredAtMs: nowMs,
    };
    this.deliveries.push(deliveryRecord);

    this.publishAudit('companion.invitation.presented', shownCandidate, nowIso);
    return shownCandidate;
  }

  /**
   * Accept an invitation on user click.
   * Action isolation: 'voice_start' triggers startVoice flag; 'text' does NOT start voice.
   */
  accept(invitationId: string, pairing: PairingScope): InvitationActionResult | null {
    const cand = this.candidates.get(invitationId);
    if (!cand || !isSamePairing(cand.pairing, pairing) || cand.status !== 'pending' ||
      !this.deliveries.some(delivery => delivery.invitationId === invitationId)) {
      return null;
    }

    if (Date.parse(cand.validUntil) <= this.getNowMs() || this.revokedSources.has(cand.sourceRef.id) ||
      !this.#sourceIsValid(cand)) {
      this.#expireCandidate(cand);
      return null;
    }

    const acceptedCandidate: InvitationCandidate = {
      ...cand,
      status: 'accepted',
    };
    this.candidates.set(invitationId, acceptedCandidate);

    const nowIso = this.clock();
    this.publishAudit('companion.invitation.accepted', acceptedCandidate, nowIso);

    return {
      action: cand.actionKind,
      text: cand.text,
      startVoice: cand.actionKind === 'voice_start',
    };
  }

  /**
   * Dismiss or ignore an invitation.
   */
  dismiss(invitationId: string, pairing: PairingScope): boolean {
    const cand = this.candidates.get(invitationId);
    if (!cand || !isSamePairing(cand.pairing, pairing) || cand.status !== 'pending' ||
      !this.deliveries.some(delivery => delivery.invitationId === invitationId)) {
      return false;
    }

    if (Date.parse(cand.validUntil) <= this.getNowMs() || this.revokedSources.has(cand.sourceRef.id) ||
      !this.#sourceIsValid(cand)) {
      this.#expireCandidate(cand);
      return false;
    }

    const dismissedCandidate: InvitationCandidate = {
      ...cand,
      status: 'dismissed',
    };
    this.candidates.set(invitationId, dismissedCandidate);

    const nowIso = this.clock();
    this.publishAudit('companion.invitation.dismissed', dismissedCandidate, nowIso);
    return true;
  }

  #sourceIsValid(candidate: InvitationCandidate): boolean {
    try { return this.isSourceValid(candidate.sourceRef) === true; } catch { return false; }
  }

  #expireCandidate(candidate: InvitationCandidate): void {
    const expired: InvitationCandidate = { ...candidate, status: 'expired' };
    this.candidates.set(candidate.id, expired);
    this.publishAudit('companion.invitation.expired', expired, this.clock());
  }

  private publishAudit(eventType: string, candidate: InvitationCandidate, nowIso: string): void {
    const envelope: CompanionEventEnvelope = {
      schemaVersion: 1,
      eventId: `inv-evt-${randomUUID()}`,
      domain: 'companion',
      type: eventType,
      pairing: candidate.pairing,
      sourceRef: { id: candidate.sourceRef.id, version: candidate.sourceRef.version },
      occurredAt: nowIso,
      receivedAt: nowIso,
      payload: {
        invitationId: candidate.id,
        reasonCode: candidate.reasonCode,
        actionKind: candidate.actionKind,
        status: candidate.status,
      },
      summary: `Proactive invitation ${candidate.id} ${eventType.split('.').pop()}`,
    };

    try {
      this.eventHub.publishEnvelope(envelope);
    } catch {
      // Best-effort audit logging
    }
  }
}
