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

export interface CaptureRequest {
  readonly grantId: string;
  readonly imageBytes: Uint8Array;
  readonly mimeType: 'image/png' | 'image/jpeg';
}

export interface PerceptionEngineOptions {
  readonly ocrEngine?: (bytes: Uint8Array, signal?: AbortSignal) => Promise<OcrResult>;
  readonly vlmEngine?: (bytes: Uint8Array, signal?: AbortSignal) => Promise<VlmObservationResult>;
}

export class ScreenPerceptionService {
  private readonly observations = new Map<string, Observation>();
  private readonly frameCache = new Map<string, { ocr?: OcrResult; vlm?: VlmObservationResult }>();

  constructor(
    private readonly grantManager: CaptureGrantManager,
    private readonly options: PerceptionEngineOptions = {},
  ) {}

  /**
   * Process a capture request under an active grant.
   */
  async processCapture(request: CaptureRequest, pairing: PairingScope): Promise<Observation> {
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
    const cacheKey = `${grant.targetId}:${frameHash}:${grant.revision}`;

    let ocr: OcrResult | undefined;
    let vlm: VlmObservationResult | undefined;

    const cached = this.frameCache.get(cacheKey);
    if (cached) {
      ocr = cached.ocr;
      vlm = cached.vlm;
    } else {
      // Run OCR if engine provided
      if (this.options.ocrEngine) {
        if (signal?.aborted) throw new Error('Capture aborted during OCR');
        ocr = await this.options.ocrEngine(request.imageBytes, signal ?? undefined);
      }

      // Run VLM if engine provided
      if (this.options.vlmEngine) {
        if (signal?.aborted) throw new Error('Capture aborted during VLM');
        vlm = await this.options.vlmEngine(request.imageBytes, signal ?? undefined);
      }

      this.frameCache.set(cacheKey, {
        ...(ocr ? { ocr } : {}),
        ...(vlm ? { vlm } : {}),
      });
    }

    // Re-check grant status after async processing
    const currentGrant = this.grantManager.getGrant(request.grantId);
    if (!currentGrant || currentGrant.status !== 'active' || signal?.aborted) {
      throw new Error('Capture rejected: grant was revoked during processing');
    }

    // If single duration, consume the grant
    if (grant.duration === 'single') {
      this.grantManager.consumeSingleGrant(request.grantId);
    }

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
    return observation;
  }

  getObservation(observationId: string): Observation | null {
    const obs = this.observations.get(observationId);
    if (!obs) return null;

    // Check grant status
    const grant = this.grantManager.getGrant(obs.grantId);
    if (!grant || grant.status === 'revoked') {
      const invalidated: Observation = { ...obs, state: 'invalidated' };
      this.observations.set(observationId, invalidated);
      return invalidated;
    }

    // Check TTL
    const elapsed = Date.now() - new Date(obs.capturedAt).getTime();
    if (elapsed > obs.ttlMs) {
      const expired: Observation = { ...obs, state: 'expired' };
      this.observations.set(observationId, expired);
      return expired;
    }

    return obs;
  }

  invalidateObservation(observationId: string): void {
    const obs = this.observations.get(observationId);
    if (obs) {
      this.observations.set(observationId, { ...obs, state: 'invalidated' });
    }
  }

  clearExpired(): void {
    const now = Date.now();
    for (const [id, obs] of this.observations.entries()) {
      if (now - new Date(obs.capturedAt).getTime() > obs.ttlMs) {
        this.observations.delete(id);
      }
    }
  }
}
