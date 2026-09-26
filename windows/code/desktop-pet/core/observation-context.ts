/**
 * core/observation-context.ts
 *
 * 08-03: Observation Context Adapter.
 * Formats time-sensitive observations as a dynamic suffix for DialoguePipeline.
 * Invariant: Never alters the frozen prefix snapshot (preserves 100% vendor KV caching).
 */

import type { Observation } from '../contracts/perception.js';
import type { ScreenPerceptionService } from './screen-perception.js';
import type { PairingScope } from '../contracts/character-pack.js';
import type { DialogueProvider, DialogueRequest, DialogueReply } from '../contracts/index.js';

export class ObservationContextAdapter {
  constructor(private readonly perceptionService: ScreenPerceptionService) {}

  /**
   * Format an observation into a dynamic suffix.
   * Returns empty string if the observation is missing, expired, or invalidated.
   */
  formatObservationSuffix(observationId: string | null | undefined, pairing: PairingScope): string {
    if (!observationId) return '';

    const obs = this.perceptionService.getObservation(observationId);
    if (!obs || obs.state !== 'active') return '';

    // Tenant / pairing isolation check
    if (
      obs.pairing.userId !== pairing.userId ||
      obs.pairing.characterId !== pairing.characterId ||
      obs.pairing.characterInstanceId !== pairing.characterInstanceId
    ) {
      return '';
    }

    const lines: string[] = [];
    lines.push(`\n\n[屏幕画面感知信息 (已授权)]`);

    if (obs.ocr?.readingOrderText) {
      lines.push(`【界面文字识别】\n${obs.ocr.readingOrderText}`);
    }

    if (obs.vlm?.summary) {
      lines.push(`【视觉内容摘要】\n${obs.vlm.summary}`);
      if (obs.vlm.uncertaintyNote) {
        lines.push(`【不确定性提示】${obs.vlm.uncertaintyNote}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Compose the final user prompt: frozenPrefix remains byte-for-byte identical,
   * user text and observation suffix are appended strictly at the end.
   */
  composePromptWithObservation(
    frozenPrefix: string,
    userText: string,
    observationId: string | null | undefined,
    pairing: PairingScope,
  ): { fullPrompt: string; dynamicSuffix: string } {
    const observationSuffix = this.formatObservationSuffix(observationId, pairing);
    const dynamicSuffix = `${userText}${observationSuffix}`;
    const fullPrompt = `${frozenPrefix}${dynamicSuffix}`;

    return {
      fullPrompt,
      dynamicSuffix,
    };
  }
}

/** Bounded one-turn handoff. It stores only an observation ID and revalidates before consumption. */
export class ObservationTurnInbox {
  private readonly pending = new Map<string, { observationId: string; expiresAt: number }>();

  constructor(
    private readonly perceptionService: ScreenPerceptionService,
    private readonly formatter: ObservationContextAdapter,
    private readonly now: () => number = Date.now,
    private readonly ttlMs = 120_000,
  ) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > 120_000) throw new Error('invalid_observation_inbox_ttl');
  }

  attach(observationId: string, pairing: PairingScope): void {
    const observation = this.perceptionService.getObservation(observationId);
    if (!observation || observation.state !== 'active' || !samePairing(observation.pairing, pairing)) {
      throw new Error('observation_not_active_for_pairing');
    }
    const key = pairingKey(pairing);
    this.pending.set(key, { observationId, expiresAt: this.now() + this.ttlMs });
  }

  consume(pairing: PairingScope): import('../contracts/perception.js').ObservationContextProjection | null {
    const key = pairingKey(pairing);
    const pending = this.pending.get(key);
    if (!pending) return null;
    this.pending.delete(key);
    if (this.now() >= pending.expiresAt) return null;
    const observation = this.perceptionService.getObservation(pending.observationId);
    if (!observation || observation.state !== 'active' || !samePairing(observation.pairing, pairing)) return null;
    const text = this.formatter.formatObservationSuffix(observation.observationId, pairing).slice(0, 6000);
    if (!text) return null;
    return {
      observationId: observation.observationId,
      grantRevision: observation.grantRevision,
      frameHash: observation.frameHash,
      capturedAt: observation.capturedAt,
      text,
    };
  }

  clear(pairing: PairingScope): void { this.pending.delete(pairingKey(pairing)); }
  close(): void { this.pending.clear(); }
}

/** Adds a queued Observation only at the final dialogue boundary, never to admission or memory writes. */
export class ObservationAwareDialogueProvider implements DialogueProvider {
  constructor(private readonly next: DialogueProvider, private readonly inbox: ObservationTurnInbox,
    private readonly pairing: PairingScope) {}

  async reply(input: DialogueRequest, signal: AbortSignal): Promise<DialogueReply> {
    const { screenObservation: _untrustedProjection, ...baseContext } = input.context;
    const request: DialogueRequest = { ...input, context: baseContext };
    const pending = request.memoryPending?.request;
    const forgetting = request.memoryOutcome?.request === 'forget' || pending === 'forget' || pending === 'uncertain';
    if (request.scope.characterId !== this.pairing.characterId || forgetting) {
      if (forgetting) this.inbox.clear(this.pairing);
      return this.next.reply(request, signal);
    }
    const projection = this.inbox.consume(this.pairing);
    return this.next.reply(projection ? { ...request, context: { ...baseContext, screenObservation: projection } } : request, signal);
  }
}

function samePairing(a: PairingScope, b: PairingScope): boolean {
  return a.userId === b.userId && a.characterId === b.characterId && a.characterInstanceId === b.characterInstanceId;
}
function pairingKey(pairing: PairingScope): string {
  return JSON.stringify([pairing.userId, pairing.characterId, pairing.characterInstanceId]);
}
