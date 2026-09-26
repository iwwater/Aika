/**
 * contracts/companion-mode.ts
 *
 * 0.82 Companion Mode Core Contracts and Invariant Validators.
 * Defines Active & Passive companion modes, extended source grants, candidates,
 * derived text, job tracking, and port boundaries without creating global state.
 */

import type { PairingScope } from './character-pack.js';
import type { SupportedImageMime } from './collection.js';

export type CompanionMode = 'active' | 'passive';
export type CompanionRunState = 'running' | 'paused' | 'error';

export type CompanionSourceKind =
  | 'keyboard'
  | 'screenshot_directory'
  | 'clipboard_image'
  | 'clipboard_text'
  | 'input_text'
  | 'manual_text'
  | 'history_reference'
  | 'download_directory';

export type SourceGrantPurpose = 'receive' | 'parse' | 'context';
export type SourceGrantDestination = 'local' | 'cloud';

export type SourceGrantState =
  | 'active'
  | 'paused'
  | 'stopped'
  | 'revoked'
  | 'expired'
  | 'unavailable'
  | 'error';

export interface CompanionModePolicy {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly pairing: PairingScope;
  readonly mode: CompanionMode;
  readonly observationIntervalMs: number;
  readonly dailyLocalTime: string; // HH:mm format, e.g., '20:00'
  readonly timezone: string;       // IANA timezone, e.g., 'Asia/Shanghai'
  readonly policyVersion: number;
}

export interface SourceGrantScope {
  readonly canonicalRoot?: string;
  readonly recursive?: boolean;
  readonly allowedApplications?: readonly string[];
  readonly allowedInputMethods?: readonly string[];
}

export interface SourceGrant {
  readonly schemaVersion: 1;
  readonly grantId: string;
  readonly revision: number;
  readonly pairing: PairingScope;
  readonly kind: CompanionSourceKind;
  readonly scope: SourceGrantScope;
  readonly purposes: readonly SourceGrantPurpose[];
  readonly destination: SourceGrantDestination;
  readonly grantedAt: string;
  readonly expiresAt: string;
  readonly profile: 'normal' | 'smoke';
  readonly state: SourceGrantState;
}

export interface ContinuousPerceptionGrant {
  readonly schemaVersion: 1;
  readonly grantId: string;
  readonly revision: number;
  readonly pairing: PairingScope;
  readonly targetId: string;
  readonly targetRevision: number;
  readonly bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly runtimeSessionId: string;
  readonly minPollIntervalMs: number;
  readonly expiry: string;
  readonly destination: 'local';
  readonly state: SourceGrantState;
}

export interface ContextUseGrant {
  readonly schemaVersion: 1;
  readonly grantId: string;
  readonly revision: number;
  readonly pairing: PairingScope;
  readonly observationSourceScopes: readonly string[];
  readonly modelBinding: string;
  readonly destination: SourceGrantDestination;
  readonly expiry: string;
  readonly state: SourceGrantState;
}

export interface SourceCandidate {
  readonly id: string;
  readonly revision: number;
  readonly pairing: PairingScope;
  readonly sourceKind: CompanionSourceKind;
  readonly grantId: string;
  readonly grantRevision: number;
  readonly modeGeneration: number;
  readonly nativeEventId: string;
  readonly occurredAt: string | null;
  readonly receivedAt: string;
  readonly origin: string;
  readonly confidence: number;
  readonly state: 'pending' | 'processing' | 'processed' | 'rejected' | 'invalidated';
  readonly expiresAt: string;
  readonly payloadRef: string;
  readonly displayName?: string | undefined;
  readonly mimeType?: string | undefined;
  readonly size?: number | undefined;
  readonly canonicalRootId?: string | undefined;
  readonly stableVersion?: string | undefined;
  readonly textByteCount?: number | undefined;
}

export interface InputTextCandidate extends SourceCandidate {
  readonly sourceKind: 'input_text';
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly appIdentity: string;
  readonly inputMethod: string;
  readonly commitId: string;
  readonly text: string;
  readonly completeness: 'committed' | 'partial_correction' | 'replacement';
  readonly captureMethod: 'ui_automation' | 'tsf' | 'direct_hook';
}

export type DerivedTextStatus =
  | 'ok'
  | 'partial'
  | 'unsupported'
  | 'missing'
  | 'failed'
  | 'cancelled';

export interface DerivedText {
  readonly id: string;
  readonly revision: number;
  readonly parentRefs: readonly { readonly sourceId: string; readonly version: string }[];
  readonly processorId: string;
  readonly processorVersion: string;
  readonly grantRevision: number;
  readonly processingKey: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly status: DerivedTextStatus;
  readonly textRef: string;
  readonly warnings: readonly string[];
}

export type JobKind = 'batch' | 'observation';
export type JobTrigger = 'manual' | 'daily' | 'catchup' | 'scheduled';
export type JobState = 'queued' | 'running' | 'succeeded' | 'partial' | 'failed' | 'cancelled';

export interface JobStatus {
  readonly jobId: string;
  readonly pairing: PairingScope;
  readonly kind: JobKind;
  readonly trigger: JobTrigger;
  readonly policyRevision: number;
  readonly generation: number;
  readonly scheduledDay: string; // YYYY-MM-DD
  readonly cutoff: string;
  readonly state: JobState;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly checkpoint: string | null;
  readonly counts: {
    readonly accepted: number;
    readonly processed: number;
    readonly failed: number;
    readonly skipped: number;
    readonly dropped: number;
  };
  readonly reasonCode: string | null;
}

export interface ModeStatus {
  readonly policy: CompanionModePolicy;
  readonly runState: CompanionRunState;
  readonly generation: number;
  readonly reasonCode: string | null;
  readonly effectiveSources: readonly {
    readonly kind: CompanionSourceKind;
    readonly state: SourceGrantState;
    readonly hasLease: boolean;
    readonly lastSuccessAt: string | null;
    readonly lastErrorCode: string | null;
  }[];
  readonly observationState: {
    readonly lastRunAt: string | null;
    readonly nextRunAt: string | null;
    readonly activeJobId: string | null;
  };
  readonly batchState: {
    readonly lastSuccessDay: string | null;
    readonly activeJobId: string | null;
  };
}

// =================================================================================================
// Invariant Validation Helpers
// =================================================================================================

export class CompanionContractError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'CompanionContractError';
  }
}

export function validateCompanionModePolicy(policy: CompanionModePolicy): void {
  if (policy.schemaVersion !== 1) throw new CompanionContractError('invalid_policy', 'Unsupported schemaVersion');
  if (!Number.isSafeInteger(policy.revision) || policy.revision < 1) throw new CompanionContractError('invalid_policy', 'revision must be positive integer');
  if (policy.mode !== 'active' && policy.mode !== 'passive') throw new CompanionContractError('invalid_policy', 'Invalid companion mode');
  if (!Number.isSafeInteger(policy.observationIntervalMs) || policy.observationIntervalMs < 1000) {
    throw new CompanionContractError('invalid_policy', 'observationIntervalMs must be at least 1000ms');
  }
  if (!/^\d{2}:\d{2}$/.test(policy.dailyLocalTime)) throw new CompanionContractError('invalid_policy', 'dailyLocalTime must be HH:mm');
  if (!policy.timezone || typeof policy.timezone !== 'string') throw new CompanionContractError('invalid_policy', 'timezone required');
}

export function validateSourceGrant(grant: SourceGrant): void {
  if (grant.schemaVersion !== 1) throw new CompanionContractError('invalid_grant', 'Unsupported schemaVersion');
  if (!grant.grantId) throw new CompanionContractError('invalid_grant', 'grantId required');
  if (grant.revision < 1) throw new CompanionContractError('invalid_grant', 'revision must be >= 1');
  if (!grant.pairing?.userId || !grant.pairing?.characterId || !grant.pairing?.characterInstanceId) {
    throw new CompanionContractError('invalid_grant', 'Valid pairing scope required');
  }
  // Safeguard: legacy keyboard cannot carry parse or context purposes
  if (grant.kind === 'keyboard' && (grant.purposes.includes('parse') || grant.purposes.includes('context'))) {
    throw new CompanionContractError('forbidden_grant_scope', 'Legacy keyboard activity cannot carry parse or context purposes');
  }
  // Safeguard: single-frame capture cannot be presented as continuous source grant
  if (grant.kind === 'screenshot_directory' && !grant.scope.canonicalRoot) {
    throw new CompanionContractError('directory_required', 'Directory source must specify canonicalRoot');
  }
}

export function validateContinuousPerceptionGrant(grant: ContinuousPerceptionGrant): void {
  if (grant.destination !== 'local') {
    throw new CompanionContractError('forbidden_destination', 'Continuous perception grant destination must be strictly local');
  }
  if (!grant.targetId || typeof grant.targetId !== 'string') {
    throw new CompanionContractError('target_required', 'targetId is required for continuous perception grant');
  }
  if (!grant.runtimeSessionId) {
    throw new CompanionContractError('session_required', 'runtimeSessionId is required');
  }
  if (grant.bounds.width <= 0 || grant.bounds.height <= 0) {
    throw new CompanionContractError('invalid_bounds', 'Target bounds must have positive dimensions');
  }
}

export function validateContextUseGrant(grant: ContextUseGrant): void {
  if (!grant.modelBinding || typeof grant.modelBinding !== 'string') {
    throw new CompanionContractError('binding_required', 'Context use grant requires a model binding');
  }
  if (grant.observationSourceScopes.length === 0) {
    throw new CompanionContractError('scopes_required', 'Observation source scopes cannot be empty');
  }
}

export function validateDerivedText(derived: DerivedText): void {
  if (derived.parentRefs.length === 0) {
    throw new CompanionContractError('orphan_derived_text', 'Derived text must reference at least one parent source');
  }
  if (!derived.processingKey) {
    throw new CompanionContractError('processing_key_required', 'processingKey is mandatory for derived text');
  }
}
