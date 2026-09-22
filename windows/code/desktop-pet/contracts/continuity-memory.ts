import type { PairingScope } from './character-pack.js';

/** N07-04: durable user/relationship continuity layered over an immutable Character Pack. */
export type ContinuityLayer = 'user_soul' | 'user_wiki' | 'relationship';
export type ContinuityFactKind = 'fact' | 'inference' | 'user_defined' | 'state' | 'milestone';
export type ContinuityFactStatus = 'candidate' | 'active' | 'superseded' | 'revoked' | 'expired';
export type ContinuityOrigin = 'user' | 'manual' | 'conversation' | 'derived' | 'assistant';

export interface ContinuityFact {
  readonly id: string;
  readonly pairing: PairingScope;
  readonly layer: ContinuityLayer;
  readonly kind: ContinuityFactKind;
  readonly status: ContinuityFactStatus;
  readonly text: string;
  readonly sourceIds: readonly string[];
  readonly origin: ContinuityOrigin;
  readonly evidenceEligible: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly validFrom?: string;
  readonly validTo?: string;
  readonly supersedesId?: string;
  readonly version: number;
  readonly revision: number;
}

export interface ContinuityMemorySnapshot {
  readonly pairing: PairingScope;
  readonly revision: number;
  readonly soul: readonly ContinuityFact[];
  readonly wiki: readonly ContinuityFact[];
  readonly relationship: readonly ContinuityFact[];
  readonly candidates: readonly ContinuityFact[];
}

export interface ContinuityRecordInput {
  readonly pairing: PairingScope;
  readonly operationId: string;
  readonly layer: ContinuityLayer;
  readonly kind: ContinuityFactKind;
  readonly text: string;
  readonly sourceIds?: readonly string[];
  readonly origin: ContinuityOrigin;
  readonly evidenceEligible?: boolean;
  readonly status?: 'candidate' | 'active';
  readonly validFrom?: string;
  readonly validTo?: string;
}

export interface ContinuityMutationResult {
  readonly status: 'applied' | 'unchanged';
  readonly fact: ContinuityFact;
  readonly revision: number;
  readonly affectedIds: readonly string[];
}

export interface ContinuityCorrectionInput {
  readonly pairing: PairingScope;
  readonly operationId: string;
  readonly targetId: string;
  readonly expectedVersion: number;
  readonly text: string;
  readonly reason: string;
  readonly sourceIds?: readonly string[];
}

export interface ContinuityForgetInput {
  readonly pairing: PairingScope;
  readonly operationId: string;
  readonly targetId: string;
  readonly expectedVersion: number;
  readonly reason: string;
}

export interface ContinuityLease {
  readonly pairing: PairingScope;
  readonly revision: number;
  readonly epoch: number;
}

export interface ContinuityDerivedCommit {
  readonly lease: ContinuityLease;
  readonly operationId: string;
  readonly layer: ContinuityLayer;
  readonly kind: ContinuityFactKind;
  readonly text: string;
  readonly sourceIds: readonly string[];
  readonly status?: 'candidate' | 'active';
}

export interface ContinuityMemoryPort {
  snapshot(pairing: PairingScope, options?: { readonly includeCandidates?: boolean; readonly now?: string }): ContinuityMemorySnapshot;
  record(input: ContinuityRecordInput): ContinuityMutationResult;
  promote(pairing: PairingScope, operationId: string, targetId: string, expectedVersion: number): ContinuityMutationResult;
  correct(input: ContinuityCorrectionInput): ContinuityMutationResult;
  forget(input: ContinuityForgetInput): ContinuityMutationResult;
  beginDerived(pairing: PairingScope): ContinuityLease;
  commitDerived(input: ContinuityDerivedCommit): ContinuityMutationResult;
  assertCurrent(lease: ContinuityLease): void;
}
