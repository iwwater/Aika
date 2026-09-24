/**
 * core/perception-grant.ts
 *
 * 08-03: Explicit Capture Grant Manager.
 * Governs window/region/screen capture permissions with revision tracking,
 * destination checking (local vs cloud), and immediate in-flight cancellation.
 */

import { randomUUID } from 'node:crypto';
import type { CaptureGrant, ProcessingDestination } from '../contracts/perception.js';

export type GrantChangeReason = 'revoked' | 'expired' | 'consumed' | 'session_ended';

export type GrantVerificationResult =
  | { readonly status: 'valid'; readonly grant: CaptureGrant }
  | {
      readonly status: 'reauthorization_required';
      readonly revokedGrantId: string;
      readonly requestedTargetId: string;
      readonly requestedDestination: ProcessingDestination;
    };

export class CaptureGrantManager {
  private readonly grants = new Map<string, CaptureGrant>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly consumedSingleGrants = new Map<string, number>();
  private readonly listeners = new Set<(grant: CaptureGrant, reason: GrantChangeReason) => void>();

  /**
   * Issue a new capture grant with revision 1.
   */
  issueGrant(params: {
    sessionId: string;
    scopeType: CaptureGrant['scopeType'];
    targetId: string;
    bounds?: { x: number; y: number; width: number; height: number };
    purpose: string;
    destination: ProcessingDestination;
    duration: 'single' | 'session';
    ttlMs?: number;
  }): CaptureGrant {
    return this.createGrant(params, 1);
  }

  /** Issue the next revision only after the trusted UI has collected an explicit confirmation. */
  reauthorizeGrant(
    previousGrantId: string,
    params: {
      sessionId: string;
      scopeType: CaptureGrant['scopeType'];
      targetId: string;
      bounds?: { x: number; y: number; width: number; height: number };
      purpose: string;
      destination: ProcessingDestination;
      duration: 'single' | 'session';
      ttlMs?: number;
    },
    userConfirmed: boolean,
  ): CaptureGrant {
    if (userConfirmed !== true) throw new Error('user_confirmation_required');
    const previous = this.grants.get(previousGrantId);
    if (!previous) throw new Error(`Grant ${previousGrantId} does not exist`);
    if (params.sessionId !== previous.sessionId) throw new Error('grant_session_scope_mismatch');
    if (previous.status === 'active') this.revokeGrant(previousGrantId);
    return this.createGrant(params, previous.revision + 1);
  }

  private createGrant(params: {
    sessionId: string;
    scopeType: CaptureGrant['scopeType'];
    targetId: string;
    bounds?: { x: number; y: number; width: number; height: number };
    purpose: string;
    destination: ProcessingDestination;
    duration: 'single' | 'session';
    ttlMs?: number;
  }, revision: number): CaptureGrant {
    const grantId = `grant-${randomUUID()}`;
    const now = new Date();
    const ttlMs = params.ttlMs ?? (params.duration === 'single' ? 60_000 : 3600_000);
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error('invalid_grant_ttl');
    const expiresAt = new Date(now.getTime() + ttlMs).toISOString();

    const grant: CaptureGrant = {
      grantId,
      revision,
      sessionId: params.sessionId,
      scopeType: params.scopeType,
      targetId: params.targetId,
      ...(params.bounds ? { bounds: params.bounds } : {}),
      purpose: params.purpose,
      destination: params.destination,
      duration: params.duration,
      grantedAt: now.toISOString(),
      expiresAt,
      status: 'active',
    };

    this.grants.set(grantId, grant);
    this.controllers.set(grantId, new AbortController());
    return grant;
  }

  subscribe(listener: (grant: CaptureGrant, reason: GrantChangeReason) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  listActiveGrants(): CaptureGrant[] {
    return [...this.grants.keys()].map(id => this.getGrant(id)).filter((grant): grant is CaptureGrant => grant?.status === 'active');
  }

  wasSingleGrantConsumed(grantId: string): boolean {
    this.pruneConsumedGrants();
    return this.consumedSingleGrants.has(grantId);
  }

  /**
   * Revoke an existing grant immediately and abort in-flight operations.
   */
  revokeGrant(grantId: string): boolean {
    const existing = this.grants.get(grantId);
    if (!existing || existing.status !== 'active') return false;
    this.transition({ ...existing, status: 'revoked' }, 'revoked');
    return true;
  }

  /**
   * Retrieve a grant, automatically evaluating time-based expiration.
   */
  getGrant(grantId: string): CaptureGrant | null {
    const existing = this.grants.get(grantId);
    if (!existing) return null;

    if (existing.status === 'active' && Date.now() >= new Date(existing.expiresAt).getTime()) {
      const expired: CaptureGrant = { ...existing, status: 'expired' };
      this.transition(expired, 'expired');
      return expired;
    }

    return existing;
  }

  /**
   * Consume a single-use grant.
   */
  consumeSingleGrant(grantId: string): void {
    const grant = this.getGrant(grantId);
    if (grant && grant.duration === 'single' && grant.status === 'active') {
      this.consumedSingleGrants.set(grantId, Date.now() + 120_000);
      this.pruneConsumedGrants();
      this.transition({ ...grant, status: 'expired' }, 'consumed');
    }
  }

  /**
   * Verify whether a grant is still valid for current target and destination.
   * If target changes or destination shifts from local to cloud, the grant is invalidated.
   */
  verifyOrReissue(
    grantId: string,
    currentTargetId: string,
    targetDest: ProcessingDestination,
  ): GrantVerificationResult {
    const existing = this.getGrant(grantId);
    if (!existing || existing.status !== 'active') {
      throw new Error(`Grant ${grantId} is not active`);
    }

    // Any target or destination change invalidates the authorization. Never silently issue a grant.
    if (existing.targetId !== currentTargetId || existing.destination !== targetDest) {
      this.revokeGrant(grantId);
      return {
        status: 'reauthorization_required',
        revokedGrantId: existing.grantId,
        requestedTargetId: currentTargetId,
        requestedDestination: targetDest,
      };
    }

    return { status: 'valid', grant: existing };
  }

  /**
   * Get the in-flight AbortSignal associated with the grant.
   */
  getSignal(grantId: string): AbortSignal | null {
    const controller = this.controllers.get(grantId);
    return controller ? controller.signal : null;
  }

  endSession(sessionId: string): number {
    let revoked = 0;
    for (const grant of this.grants.values()) {
      if (grant.sessionId !== sessionId) continue;
      this.consumedSingleGrants.delete(grant.grantId);
      if (grant.status === 'active') {
        this.transition({ ...grant, status: 'revoked' }, 'session_ended');
        revoked++;
      } else {
        // A consumed single-use grant is already expired, but its Observation
        // may remain readable by the current turn until this session ends.
        this.transition(grant, 'session_ended');
      }
    }
    return revoked;
  }

  private transition(grant: CaptureGrant, reason: GrantChangeReason): void {
    this.controllers.get(grant.grantId)?.abort();
    this.controllers.delete(grant.grantId);
    this.grants.set(grant.grantId, grant);
    for (const listener of [...this.listeners]) {
      try { listener(grant, reason); } catch { /* A cleanup listener must not block revocation. */ }
    }
  }

  private pruneConsumedGrants(): void {
    const now = Date.now();
    for (const [grantId, expiresAt] of this.consumedSingleGrants) {
      if (now >= expiresAt) this.consumedSingleGrants.delete(grantId);
    }
    // Observation capacity is bounded too; keep a hard cap in case grants are
    // consumed faster than the two-minute observation window can expire.
    while (this.consumedSingleGrants.size > 512) {
      const oldest = this.consumedSingleGrants.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.consumedSingleGrants.delete(oldest);
    }
  }
}
