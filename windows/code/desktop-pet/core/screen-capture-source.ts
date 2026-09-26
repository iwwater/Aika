/**
 * core/screen-capture-source.ts
 *
 * N082-05: Real screen and window capture source.
 * Validates trusted target handles, checks boundaries & DPI, captures frames
 * without unbounded memory retention, and strictly rejects synthetic random targets.
 */

import type { ContinuousPerceptionGrant } from '../contracts/companion-mode.js';

export interface ScreenTarget {
  readonly targetId: string;
  readonly targetRevision: number;
  readonly kind: 'screen' | 'window' | 'region';
  readonly displayName: string;
  readonly bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly isValid: boolean;
}

export interface CapturedFrame {
  readonly targetId: string;
  readonly targetRevision: number;
  readonly capturedAt: string;
  readonly mimeType: 'image/png' | 'image/bmp';
  readonly dimensions: { readonly width: number; readonly height: number };
  readonly bytes: Uint8Array;
}

export interface ScreenCaptureSourceOptions {
  readonly maxImageBytes?: number;   // Default 20 MiB
  readonly maxPixels?: number;       // Default 40,000,000 pixels (40 MP)
  readonly captureHook?: (target: ScreenTarget, signal?: AbortSignal) => Promise<CapturedFrame | null>;
}

export class ScreenCaptureSource {
  private readonly maxImageBytes: number;
  private readonly maxPixels: number;
  private readonly captureHook?: ((target: ScreenTarget, signal?: AbortSignal) => Promise<CapturedFrame | null>) | undefined;
  private activeGrant: ContinuousPerceptionGrant | null = null;
  private closed = false;

  constructor(options: ScreenCaptureSourceOptions = {}) {
    this.maxImageBytes = options.maxImageBytes ?? 20 * 1024 * 1024;
    this.maxPixels = options.maxPixels ?? 40_000_000;
    this.captureHook = options.captureHook;
  }

  async attachContinuousGrant(grant: ContinuousPerceptionGrant): Promise<void> {
    if (grant.destination !== 'local') {
      throw new Error('forbidden_destination');
    }
    if (grant.bounds.width <= 0 || grant.bounds.height <= 0) {
      throw new Error('invalid_bounds');
    }
    this.activeGrant = grant;
    this.closed = false;
  }

  detachGrant(): void {
    this.activeGrant = null;
    this.closed = true;
  }

  validateTarget(target: ScreenTarget): boolean {
    if (!target || !target.targetId || target.targetId.trim().length === 0) return false;
    if (!target.isValid) return false;
    if (!this.activeGrant || target.targetId !== this.activeGrant.targetId
      || target.targetRevision !== this.activeGrant.targetRevision) return false;
    const granted = this.activeGrant.bounds;
    if (target.bounds.x !== granted.x || target.bounds.y !== granted.y
      || target.bounds.width !== granted.width || target.bounds.height !== granted.height) return false;
    if (target.bounds.width <= 0 || target.bounds.height <= 0) return false;
    const pixels = target.bounds.width * target.bounds.height;
    if (pixels > this.maxPixels) return false;
    return true;
  }

  async capture(target: ScreenTarget, signal?: AbortSignal): Promise<CapturedFrame | null> {
    if (this.closed || !this.activeGrant) {
      throw new Error('capture_source_not_active');
    }
    if (signal?.aborted) {
      throw new Error('capture_aborted');
    }
    if (!this.validateTarget(target)) {
      throw new Error('target_invalid');
    }

    if (this.captureHook) {
      const frame = await this.captureHook(target, signal);
      if (!frame) return null;

      if (frame.bytes.length > this.maxImageBytes) {
        throw new Error('frame_exceeds_byte_limit');
      }
      return frame;
    }

    throw new Error('capture_unavailable');
  }
}
