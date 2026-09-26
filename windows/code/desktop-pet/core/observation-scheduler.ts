/**
 * core/observation-scheduler.ts
 *
 * N082-06: Active periodic observation scheduler.
 * Ticks periodic screen capture + local pixel OCR under bounded concurrency.
 * Ensures misses are never retroactively backfilled and dialog interactions take priority.
 */

import { randomUUID } from 'node:crypto';
import type { PairingScope } from '../contracts/character-pack.js';
import type { ContinuousPerceptionGrant } from '../contracts/companion-mode.js';
import type { ScreenCaptureSource, ScreenTarget } from './screen-capture-source.js';
import type { createLocalOcrEngine } from './local-ocr-engine.js';

export interface ObservationItem {
  readonly observationId: string;
  readonly targetId: string;
  readonly capturedAt: string;
  readonly text: string;
  readonly blockCount: number;
}

export interface ObservationSchedulerOptions {
  readonly pairing: PairingScope;
  readonly captureSource: ScreenCaptureSource;
  readonly ocrEngine: ReturnType<typeof createLocalOcrEngine>;
  readonly onObservation?: (item: ObservationItem) => void;
  readonly now?: () => string;
}

export class ObservationScheduler {
  private readonly pairing: PairingScope;
  private readonly captureSource: ScreenCaptureSource;
  private readonly ocrEngine: ReturnType<typeof createLocalOcrEngine>;
  private readonly onObservation?: ((item: ObservationItem) => void) | undefined;
  private readonly now: () => string;
  private isBusy = false;
  private generation = 0;
  private activeAbort: AbortController | null = null;
  private currentGrant: ContinuousPerceptionGrant | null = null;
  private currentTarget: ScreenTarget | null = null;

  constructor(options: ObservationSchedulerOptions) {
    this.pairing = options.pairing;
    this.captureSource = options.captureSource;
    this.ocrEngine = options.ocrEngine;
    this.onObservation = options.onObservation;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  setContext(grant: ContinuousPerceptionGrant | null, target: ScreenTarget | null): void {
    this.cancel();
    this.currentGrant = grant;
    this.currentTarget = target;
  }

  get inFlight(): boolean {
    return this.isBusy;
  }

  /**
   * Periodic scheduler tick.
   * If busy or unauthorized or passive, silently skips (never backfills missed ticks).
   */
  async tick(signal?: AbortSignal): Promise<ObservationItem | null> {
    if (this.isBusy) return null;
    if (!this.currentGrant || this.currentGrant.state !== 'active') return null;
    if (!this.currentTarget || !this.currentTarget.isValid) return null;
    if (signal?.aborted) return null;

    return this.#runObservation(signal);
  }

  /**
   * User or console explicit trigger ("立即观察").
   */
  async observeNow(operationId: string = randomUUID(), signal?: AbortSignal): Promise<ObservationItem | null> {
    if (this.isBusy) {
      throw new Error('observation_busy');
    }
    if (!this.currentGrant || this.currentGrant.state !== 'active') {
      throw new Error('observation_not_authorized');
    }
    if (!this.currentTarget || !this.currentTarget.isValid) {
      throw new Error('target_invalid');
    }

    return this.#runObservation(signal);
  }

  async #runObservation(signal?: AbortSignal): Promise<ObservationItem | null> {
    this.isBusy = true;
    const generation = this.generation;
    const grant = this.currentGrant;
    const target = this.currentTarget;
    const abort = new AbortController();
    this.activeAbort = abort;
    const forwardAbort = () => abort.abort();
    if (signal?.aborted) abort.abort();
    else signal?.addEventListener('abort', forwardAbort, { once: true });
    const current = () => !abort.signal.aborted && this.generation === generation
      && this.currentGrant === grant && this.currentTarget === target
      && grant?.state === 'active' && Date.parse(grant.expiry) > Date.parse(this.now());
    try {
      const frame = await this.captureSource.capture(target!, abort.signal);
      if (!current()) return null;
      if (!frame || frame.bytes.length === 0) return null;

      const ocr = await this.ocrEngine(frame.bytes, abort.signal);
      if (!current()) return null;
      if (ocr.status !== 'ok' || !ocr.readingOrderText.trim()) {
        return null;
      }

      const item: ObservationItem = {
        observationId: `obs-${randomUUID()}`,
        targetId: frame.targetId,
        capturedAt: frame.capturedAt,
        text: ocr.readingOrderText,
        blockCount: ocr.blocks.length,
      };

      if (!current()) return null;
      this.onObservation?.(item);
      return item;
    } finally {
      signal?.removeEventListener('abort', forwardAbort);
      if (this.activeAbort === abort) {
        this.activeAbort = null;
        this.isBusy = false;
      }
    }
  }

  cancel(): void {
    this.generation++;
    this.activeAbort?.abort();
  }
}
