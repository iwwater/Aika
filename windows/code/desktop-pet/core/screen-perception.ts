/**
 * core/screen-perception.ts
 *
 * 08-03: Screen Perception Service.
 * Coordinates OCR & VLM extraction against authorized capture requests.
 * Ensures raw images are immediately dropped and only structured observations are retained.
 */

import { createHash, randomUUID } from 'node:crypto';
import type { Observation, OcrResult, VlmObservationResult } from '../contracts/perception.js';
import type { PairingScope } from '../contracts/character-pack.js';
import type { CaptureGrantManager } from './perception-grant.js';
import type { GrantChangeReason } from './perception-grant.js';

export interface CaptureRequest {
  readonly grantId: string;
  readonly imageBytes: Uint8Array;
  readonly mimeType: 'image/png' | 'image/jpeg';
}

export interface PerceptionEngineOptions {
  /** Local-only engines. They must not forward capture bytes to a remote service. */
  readonly localOcrEngine?: (bytes: Uint8Array, signal?: AbortSignal) => Promise<OcrResult>;
  readonly localVlmEngine?: (bytes: Uint8Array, signal?: AbortSignal) => Promise<VlmObservationResult>;
  /** Cloud processing is a separate explicit route selected only by a cloud grant. */
  readonly cloudVlmEngine?: (bytes: Uint8Array, signal?: AbortSignal, context?: {
    readonly grant: import('../contracts/perception.js').CaptureGrant;
    readonly pairing: PairingScope;
    readonly mimeType: 'image/png' | 'image/jpeg';
  }) => Promise<VlmObservationResult>;
}

export interface PerceptionLifecycleOptions {
  readonly cacheTtlMs?: number;
  readonly cacheCapacity?: number;
  readonly observationCapacity?: number;
  readonly now?: () => number;
}

interface FrameCacheEntry {
  readonly grantId: string;
  readonly expiresAt: number;
  readonly value: { readonly ocr?: OcrResult; readonly vlm?: VlmObservationResult };
}

export class ScreenPerceptionService {
  private readonly observations = new Map<string, Observation>();
  private readonly frameCache = new Map<string, FrameCacheEntry>();
  private readonly cacheTtlMs: number;
  private readonly cacheCapacity: number;
  private readonly observationCapacity: number;
  private readonly now: () => number;
  private readonly unsubscribeGrantChanges: () => void;
  private readonly cleanupTimer: ReturnType<typeof setInterval>;

  constructor(
    private readonly grantManager: CaptureGrantManager,
    private readonly options: PerceptionEngineOptions = {},
    lifecycle: PerceptionLifecycleOptions = {},
  ) {
    this.cacheTtlMs = Math.max(0, lifecycle.cacheTtlMs ?? 30_000);
    this.cacheCapacity = Math.max(0, lifecycle.cacheCapacity ?? 64);
    this.observationCapacity = Math.max(1, lifecycle.observationCapacity ?? 256);
    this.now = lifecycle.now ?? Date.now;
    this.unsubscribeGrantChanges = grantManager.subscribe((grant, reason) => this.onGrantChange(grant.grantId, reason));
    this.cleanupTimer = setInterval(() => this.clearExpired(), 1_000);
    this.cleanupTimer.unref?.();
  }

  /**
   * Process a capture request under an active grant.
   */
  async processCapture(request: CaptureRequest, pairing: PairingScope): Promise<Observation> {
    this.clearExpired();
    if (!(request.imageBytes instanceof Uint8Array) || request.imageBytes.byteLength === 0 || request.imageBytes.byteLength > 1_500_000) {
      throw new Error('capture_frame_size_invalid');
    }
    if (request.mimeType !== 'image/png' && request.mimeType !== 'image/jpeg') throw new Error('capture_frame_type_invalid');
    const grant = this.grantManager.getGrant(request.grantId);
    if (!grant || grant.status !== 'active') {
      throw new Error(`Capture rejected: grant ${request.grantId} is not active`);
    }

    const signal = this.grantManager.getSignal(request.grantId);
    if (signal?.aborted) {
      throw new Error('Capture aborted: grant was revoked');
    }

    // Compute frame hash
    const frameHash = createHash('sha256').update(request.imageBytes).digest('hex');
    const cacheKey = JSON.stringify([
      grant.grantId, grant.revision, grant.sessionId, grant.targetId,
      pairing.userId, pairing.characterId, pairing.characterInstanceId, frameHash,
    ]);

    let ocr: OcrResult | undefined;
    let vlm: VlmObservationResult | undefined;

    const cached = this.getCached(cacheKey);
    if (cached) {
      ocr = cached.ocr;
      vlm = cached.vlm;
    } else {
      if (grant.destination === 'cloud') {
        if (!this.options.cloudVlmEngine) throw new Error('cloud_perception_engine_unavailable');
        if (signal?.aborted) throw new Error('Capture aborted before cloud VLM');
        vlm = await this.options.cloudVlmEngine(request.imageBytes, signal ?? undefined, { grant, pairing, mimeType: request.mimeType });
      } else {
        if (!this.options.localOcrEngine && !this.options.localVlmEngine) throw new Error('local_perception_engine_unavailable');
        if (this.options.localOcrEngine) {
          if (signal?.aborted) throw new Error('Capture aborted during local OCR');
          ocr = await this.options.localOcrEngine(request.imageBytes, signal ?? undefined);
        }
        if (this.options.localVlmEngine) {
          if (signal?.aborted) throw new Error('Capture aborted during local VLM');
          vlm = await this.options.localVlmEngine(request.imageBytes, signal ?? undefined);
        }
      }

    }

    // Re-check the grant before caching, storing, or passing the observation to a turn.
    const currentGrant = this.grantManager.getGrant(request.grantId);
    if (!currentGrant || currentGrant.status !== 'active' || signal?.aborted) {
      throw new Error('Capture rejected: grant was revoked during processing');
    }

    if (!cached) this.setCached(cacheKey, grant.grantId, {
      ...(ocr ? { ocr } : {}),
      ...(vlm ? { vlm } : {}),
    });

    // Explicitly do NOT retain request.imageBytes
    const observationId = `obs-${randomUUID()}`;
    const observation: Observation = {
      observationId,
      pairing,
      grantId: grant.grantId,
      grantRevision: grant.revision,
      frameHash,
      capturedAt: new Date().toISOString(),
      ...(ocr ? { ocr } : {}),
      ...(vlm ? { vlm } : {}),
      state: 'active',
      ttlMs: 120_000,
    };

    this.observations.set(observationId, observation);
    this.trimObservations();
    // A successful single capture may supply this turn's context, but cannot be reused for another capture.
    if (grant.duration === 'single') this.grantManager.consumeSingleGrant(request.grantId);
    return observation;
  }

  getObservation(observationId: string): Observation | null {
    const obs = this.observations.get(observationId);
    if (!obs) return null;

    // Check grant status
    const grant = this.grantManager.getGrant(obs.grantId);
    if (!grant || grant.status === 'revoked' || (grant.status === 'expired' && !this.grantManager.wasSingleGrantConsumed(obs.grantId))) {
      return this.redactObservation(observationId, obs, 'invalidated');
    }

    // Check TTL
    const elapsed = this.now() - new Date(obs.capturedAt).getTime();
    if (elapsed >= obs.ttlMs) {
      return this.redactObservation(observationId, obs, 'expired');
    }

    return obs;
  }

  invalidateObservation(observationId: string): void {
    const obs = this.observations.get(observationId);
    if (obs) {
      this.redactObservation(observationId, obs, 'invalidated');
    }
  }

  clearExpired(): void {
    const now = this.now();
    for (const [id, obs] of this.observations.entries()) {
      if (now - new Date(obs.capturedAt).getTime() >= obs.ttlMs) {
        this.observations.delete(id);
      }
    }
    for (const [key, entry] of this.frameCache.entries()) {
      if (now >= entry.expiresAt) this.frameCache.delete(key);
    }
  }

  close(): void {
    clearInterval(this.cleanupTimer);
    this.unsubscribeGrantChanges();
    this.frameCache.clear();
    this.observations.clear();
  }

  private getCached(key: string): FrameCacheEntry['value'] | undefined {
    const entry = this.frameCache.get(key);
    if (!entry) return undefined;
    if (this.now() >= entry.expiresAt) {
      this.frameCache.delete(key);
      return undefined;
    }
    this.frameCache.delete(key);
    this.frameCache.set(key, entry);
    return entry.value;
  }

  private setCached(key: string, grantId: string, value: FrameCacheEntry['value']): void {
    if (this.cacheCapacity === 0 || this.cacheTtlMs === 0) return;
    this.frameCache.delete(key);
    this.frameCache.set(key, { grantId, expiresAt: this.now() + this.cacheTtlMs, value });
    while (this.frameCache.size > this.cacheCapacity) {
      const oldest = this.frameCache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.frameCache.delete(oldest);
    }
  }

  private onGrantChange(grantId: string, reason: GrantChangeReason): void {
    for (const [key, entry] of this.frameCache.entries()) {
      if (entry.grantId === grantId) this.frameCache.delete(key);
    }
    if (reason === 'consumed') return;
    for (const [id, obs] of this.observations.entries()) {
      if (obs.grantId === grantId) this.redactObservation(id, obs,
        reason === 'revoked' || reason === 'session_ended' ? 'invalidated' : 'expired');
    }
  }

  private redactObservation(id: string, obs: Observation, state: 'invalidated' | 'expired'): Observation {
    const redacted: Observation = {
      observationId: obs.observationId,
      pairing: obs.pairing,
      grantId: obs.grantId,
      grantRevision: obs.grantRevision,
      frameHash: obs.frameHash,
      capturedAt: obs.capturedAt,
      state,
      ttlMs: obs.ttlMs,
    };
    this.observations.set(id, redacted);
    return redacted;
  }

  private trimObservations(): void {
    while (this.observations.size > this.observationCapacity) {
      const oldest = this.observations.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.observations.delete(oldest);
    }
  }
}
