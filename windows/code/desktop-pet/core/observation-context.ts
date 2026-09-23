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
