import type { PairingScope, ContinuitySnapshot } from './character-pack.js';
import type { ContinuityFact, ContinuityMemorySnapshot } from './continuity-memory.js';

export type ContinuityContextSource = 'character_soul' | 'relationship' | 'user_soul' | 'canon_timeline' | 'user_wiki' | 'companion_timeline';

export interface ContinuityContextSegment {
  readonly key: string;
  readonly source: ContinuityContextSource;
  readonly text: string;
  readonly evidenceIds: readonly string[];
  readonly tokens: number;
  readonly selected: boolean;
  readonly reason: string;
}

export interface ContinuityContextRequest {
  readonly pairing: PairingScope;
  readonly query: string;
  readonly tokenBudget: number;
  readonly maxCanonEvents?: number;
  readonly maxCompanionEvents?: number;
  readonly now?: string;
  readonly cutoffPoint?: string;
}

export interface ContinuityContextResult {
  readonly pairing: PairingScope;
  readonly revision: string;
  readonly text: string;
  readonly segments: readonly ContinuityContextSegment[];
  readonly selected: readonly ContinuityContextSegment[];
  readonly omitted: readonly ContinuityContextSegment[];
  readonly continuity: ContinuitySnapshot;
  readonly memory: ContinuityMemorySnapshot;
}

export interface ContinuityContextSourceAdapter {
  compose(request: ContinuityContextRequest): Promise<ContinuityContextResult>;
  assertCurrent(result: ContinuityContextResult): void | Promise<void>;
}

export function factSegment(source: 'relationship' | 'user_soul' | 'user_wiki', fact: ContinuityFact, estimate: (text: string) => number): ContinuityContextSegment {
  return Object.freeze({ key: `fact:${fact.id}`, source, text: fact.text, evidenceIds: fact.sourceIds, tokens: estimate(fact.text), selected: false, reason: fact.kind === 'inference' ? '有来源的推断' : fact.origin === 'manual' ? '用户纠正/设定' : '当前配对有效条目' });
}
