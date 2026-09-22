// N075-01/R2: the production adapter that puts the N07 continuity stores into the formal dialogue
// context. It is a read-only projection: it composes the immutable Character Pack and pair-scoped
// continuity data into one ContinuityContextResult, re-verifies the revisions it composed, and owns
// no storage. It never calls a model and never becomes a second dialogue pipeline.
import type { PairingScope, ContinuityPairingResolver } from '../contracts/character-pack.js';
import type { ContinuityContextRequest, ContinuityContextResult, ContinuityContextSourceAdapter } from '../contracts/continuity-context.js';
import { ContinuityContextComposer } from './continuity-context.js';
import type { CharacterPackStore } from './character-pack-store.js';
import type { ContinuityMemoryStore } from './continuity-memory-store.js';

/**
 * N075-01/R2: production pairing resolver. 0.7 delivered instance-scoped pairing for the management
 * plane; the desktop product currently runs the single local user against the canonical companion
 * instance (the same default the console snapshot API already assumes). A pack store instance row
 * (`character_instances`) remains the authority for multi-instance characters; until the desktop
 * product surface exposes instance switching, the desktop pairing resolves to the canonical default.
 */
export function productionPairingResolver(instanceId: string): ContinuityPairingResolver {
  const instance = instanceId.trim();
  if (!instance) throw new Error('continuity_instance_required');
  return {
    pairingFor(scope: { readonly characterId: string }): PairingScope | null {
      return productionPairing(scope.characterId, instance);
    },
  };
}

import { productionPairing } from '../contracts/character-pack.js';

/** Bounded projection limits for a production dialogue turn: enough context, never unbounded. */
const PRODUCTION_MAX_CANON_EVENTS = 50;
const PRODUCTION_MAX_COMPANION_EVENTS = 50;
/** Conservative share of the dialogue input budget handed to the composed continuity text. */
const CONTINUITY_BUDGET_SHARE = 0.3;
const CONTINUITY_BUDGET_MAX = 4000;

export interface ProductionContinuityContextOptions {
  readonly packs: CharacterPackStore;
  readonly memory: ContinuityMemoryStore;
  readonly pairing: ContinuityPairingResolver;
  readonly dialogueInputTokenBudget: number;
}

/**
 * Production continuity context source. One instance is created in the composition root and handed
 * to the memory port as the per-turn `continuity` reader; the same composer the acceptance tooling
 * uses does the segment work, so production consumes the exact validated composition semantics.
 */
export class ProductionContinuityContext {
  readonly #composer: ContinuityContextComposer;
  constructor(private readonly options: ProductionContinuityContextOptions) {
    this.#composer = new ContinuityContextComposer(options.packs, options.memory);
  }

  /** The pairing for a desktop scope, or null when this character has no continuity pairing. */
  pairingFor(characterId: string): PairingScope | null {
    return this.options.pairing.pairingFor({ characterId });
  }

  /**
   * The per-turn reader shape the memory port expects: resolve the pairing, compose under the
   * production budget, and re-verify what was composed. Returns null only when the character has no
   * active continuity pairing (the capability-off case must stay an ordinary text turn).
   */
  async contextFor(characterId: string, query: string): Promise<ContinuityContextResult | null> {
    const pairing = this.pairingFor(characterId);
    if (!pairing) return null;
    const request: ContinuityContextRequest = {
      pairing,
      query,
      tokenBudget: Math.max(1, Math.min(CONTINUITY_BUDGET_MAX, Math.floor(this.options.dialogueInputTokenBudget * CONTINUITY_BUDGET_SHARE))),
      maxCanonEvents: PRODUCTION_MAX_CANON_EVENTS,
      maxCompanionEvents: PRODUCTION_MAX_COMPANION_EVENTS,
    };
    const result = await this.#composer.compose(request);
    await this.#composer.assertCurrent(result);
    return result;
  }
}
