/**
 * companion/observation-candidate-source.ts
 *
 * N082-07: Observation context candidate generator & sharing arbitrator.
 * Generates proactive context cues from screen observations while enforcing
 * daily quotas (shared with invitations), cooldowns, ContextUseGrant checks,
 * and passive mode suppression.
 */

import { randomUUID } from 'node:crypto';
import type { PairingScope } from '../contracts/character-pack.js';
import type {
  CompanionMode,
  ContextUseGrant,
} from '../contracts/companion-mode.js';
import type { ObservationItem } from '../core/observation-scheduler.js';

export interface ProactiveCueCandidate {
  readonly cueId: string;
  readonly observationId: string;
  readonly pairing: PairingScope;
  readonly text: string;
  readonly promptSummary: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface ObservationCompanionOptions {
  readonly pairing: PairingScope;
  readonly getMode: () => CompanionMode;
  readonly getContextGrant?: () => ContextUseGrant | null;
  readonly dailyQuotaLimit?: number;      // Default 2 times per day
  readonly cooldownIntervalMs?: number;   // Default 3 hours (10,800,000 ms)
  readonly generateCueHook?: (observationText: string, signal?: AbortSignal) => Promise<string | null>;
  readonly now?: () => string;
}

export class ObservationCandidateSource {
  private readonly pairing: PairingScope;
  private readonly getMode: () => CompanionMode;
  private readonly getContextGrant?: (() => ContextUseGrant | null) | undefined;
  private readonly dailyQuotaLimit: number;
  private readonly cooldownIntervalMs: number;
  private readonly generateCueHook?: ((observationText: string, signal?: AbortSignal) => Promise<string | null>) | undefined;
  private readonly now: () => string;

  private isGenerating = false;
  private lastOfferedAt = 0;
  private dailyOfferedDays = new Map<string, number>(); // day -> count
  private readonly activeCues = new Map<string, ProactiveCueCandidate>();

  constructor(options: ObservationCompanionOptions) {
    this.pairing = options.pairing;
    this.getMode = options.getMode;
    this.getContextGrant = options.getContextGrant;
    this.dailyQuotaLimit = options.dailyQuotaLimit ?? 2;
    this.cooldownIntervalMs = options.cooldownIntervalMs ?? 10_800_000;
    this.generateCueHook = options.generateCueHook;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /**
   * Offer an observation to be considered for a proactive companion cue.
   * Suppressed in passive mode, when quota exhausted, in cooldown, or when lacking ContextUseGrant.
   */
  async offer(observation: ObservationItem, signal?: AbortSignal): Promise<ProactiveCueCandidate | null> {
    if (signal?.aborted) return null;

    // 1. Passive mode suppression: completely suppresses proactive observation output
    if (this.getMode() === 'passive') {
      return null;
    }

    // 2. Concurrency bound = 1
    if (this.isGenerating) {
      return null;
    }

    // 3. ContextUseGrant check for cloud/model use
    const contextGrant = this.getContextGrant?.();
    if (!contextGrant || contextGrant.state !== 'active') {
      return null;
    }

    // 4. Cooldown check
    const currentTime = Date.parse(this.now());
    if (this.lastOfferedAt > 0 && (currentTime - this.lastOfferedAt) < this.cooldownIntervalMs) {
      return null;
    }

    // 5. Daily quota ledger check (max 2 per day)
    const today = this.now().slice(0, 10);
    const dayCount = this.dailyOfferedDays.get(today) ?? 0;
    if (dayCount >= this.dailyQuotaLimit) {
      return null;
    }

    this.isGenerating = true;
    try {
      let cueText = `观察到屏幕内容：${observation.text.slice(0, 30)}...`;
      if (this.generateCueHook) {
        const generated = await this.generateCueHook(observation.text, signal);
        if (!generated || !generated.trim()) return null;
        cueText = generated.trim();
      }

      const cueId = `cue-${randomUUID()}`;
      const candidate: ProactiveCueCandidate = {
        cueId,
        observationId: observation.observationId,
        pairing: this.pairing,
        text: cueText,
        promptSummary: observation.text.slice(0, 100),
        createdAt: this.now(),
        expiresAt: new Date(currentTime + 300_000).toISOString(), // 5min valid
      };

      this.activeCues.set(cueId, candidate);
      this.lastOfferedAt = currentTime;
      this.dailyOfferedDays.set(today, dayCount + 1);

      return candidate;
    } finally {
      this.isGenerating = false;
    }
  }

  withdraw(cueId: string): void {
    this.activeCues.delete(cueId);
  }

  getCue(cueId: string): ProactiveCueCandidate | null {
    const cue = this.activeCues.get(cueId);
    if (!cue) return null;
    if (Date.parse(cue.expiresAt) <= Date.parse(this.now())) {
      this.activeCues.delete(cueId);
      return null;
    }
    return cue;
  }
}
