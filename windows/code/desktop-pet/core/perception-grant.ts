/**
 * core/perception-grant.ts
 *
 * 08-03: Explicit Capture Grant Manager.
 * Governs window/region/screen capture permissions with revision tracking,
 * destination checking (local vs cloud), and immediate in-flight cancellation.
 */

import { randomUUID } from 'node:crypto';
import type { CaptureGrant, ProcessingDestination } from '../contracts/perception.js';

export class CaptureGrantManager {
  private readonly grants = new Map<string, CaptureGrant>();
  private readonly controllers = new Map<string, AbortController>();

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
    const grantId = `grant-${randomUUID()}`;
    const now = new Date();
    const ttlMs = params.ttlMs ?? (params.duration === 'single' ? 60_000 : 3600_000);
    const expiresAt = new Date(now.getTime() + ttlMs).toISOString();

    const grant: CaptureGrant = {
      grantId,
      revision: 1,
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

  /**
   * Revoke an existing grant immediately and abort in-flight operations.
   */
  revokeGrant(grantId: string): boolean {
    const existing = this.grants.get(grantId);
    if (!existing) return false;

    const controller = this.controllers.get(grantId);
    if (controller) {
      controller.abort();
      this.controllers.delete(grantId);
    }

    this.grants.set(grantId, { ...existing, status: 'revoked' });
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
      this.grants.set(grantId, expired);
      this.controllers.delete(grantId);
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
      this.grants.set(grantId, { ...grant, status: 'expired' });
      this.controllers.delete(grantId);
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
  ): { grant: CaptureGrant; reissued: boolean } {
    const existing = this.getGrant(grantId);
    if (!existing || existing.status !== 'active') {
      throw new Error(`Grant ${grantId} is not active`);
    }

    // Changing target window or escalating from local to cloud invalidates the current grant
    if (existing.targetId !== currentTargetId || (existing.destination === 'local' && targetDest === 'cloud')) {
      this.revokeGrant(grantId);
      const newGrant = this.issueGrant({
        sessionId: existing.sessionId,
        scopeType: existing.scopeType,
        targetId: currentTargetId,
        ...(existing.bounds ? { bounds: existing.bounds } : {}),
        purpose: existing.purpose,
        destination: targetDest,
        duration: existing.duration,
      });
      return { grant: newGrant, reissued: true };
    }

    return { grant: existing, reissued: false };
  }

  /**
   * Get the in-flight AbortSignal associated with the grant.
   */
  getSignal(grantId: string): AbortSignal | null {
    const controller = this.controllers.get(grantId);
    return controller ? controller.signal : null;
  }
}
