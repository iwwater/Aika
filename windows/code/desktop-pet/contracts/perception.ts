/**
 * contracts/perception.ts
 *
 * 08-00 Baseline Frozen Contracts:
 * Defines CaptureGrant, Observation, CompanionEventEnvelope, InvitationCandidate, WorkRequest, and WorkReceipt.
 *
 * Requirements:
 * - Single dialogue turn authority: no duplicate turn arbiters.
 * - Confinement: clear data destinations (local vs cloud).
 * - Decoupling: short-term observations are strictly separated from long-term memory.
 */

import type { PairingScope } from './character-pack.js';

// --- 1. CaptureGrant -----------------------------------------------------------------------------

export type GrantScopeType = 'window' | 'region' | 'screen';
export type ProcessingDestination = 'local' | 'cloud';
export type GrantStatus = 'active' | 'revoked' | 'expired';

export interface CaptureGrant {
  readonly grantId: string;
  readonly revision: number;
  readonly sessionId: string;
  readonly scopeType: GrantScopeType;
  readonly targetId: string;
  readonly bounds?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly purpose: string;
  readonly destination: ProcessingDestination;
  readonly duration: 'single' | 'session';
  readonly grantedAt: string;
  readonly expiresAt: string;
  readonly status: GrantStatus;
}

/**
 * 08-04 Requirement: Continuous perception for proactive invitations requires an explicit,
 * independent continuous grant. Single-use dialog capture grants (duration: 'single') MUST NEVER
 * be escalated into background proactive triggers.
 */
export interface ContinuousPerceptionGrant {
  readonly continuousGrantId: string;
  readonly revision: number;
  readonly pairing: PairingScope;
  readonly scopeType: GrantScopeType;
  readonly destination: 'local'; // Continuous background scanning is strictly restricted to local processing
  readonly minPollIntervalMs: number;
  readonly grantedAt: string;
  readonly expiresAt: string;
  readonly status: GrantStatus;
}

// --- 2. Observation ------------------------------------------------------------------------------

export interface OcrTextBlock {
  readonly text: string;
  readonly confidence: number;
  readonly bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
}

export interface OcrResult {
  readonly status: 'ok' | 'partial' | 'failed';
  readonly blocks: readonly OcrTextBlock[];
  readonly readingOrderText: string;
  readonly language?: string;
  readonly engine: string;
}

export interface VlmObservationResult {
  readonly status: 'ok' | 'partial' | 'uncertain' | 'failed';
  readonly summary: string;
  readonly visualElements: readonly string[];
  readonly uncertaintyNote?: string;
  readonly rawExcluded: true;
}

export interface Observation {
  readonly observationId: string;
  readonly pairing: PairingScope;
  readonly grantId: string;
  readonly grantRevision: number;
  readonly frameHash: string;
  readonly capturedAt: string;
  readonly ocr?: OcrResult;
  readonly vlm?: VlmObservationResult;
  readonly state: 'active' | 'consumed' | 'invalidated' | 'expired';
  readonly ttlMs: number;
}

/** Ephemeral, one-turn projection of an explicitly attached Observation. Never stored in History. */
export interface ObservationContextProjection {
  readonly observationId: string;
  readonly grantRevision: number;
  readonly frameHash: string;
  readonly capturedAt: string;
  /** Rendered as untrusted, time-sensitive data in the current dialogue request only. */
  readonly text: string;
}

// --- 3. CompanionEventEnvelope -------------------------------------------------------------------

export type EventDomain = 'canon' | 'companion' | 'work' | 'collection';

export interface CompanionEventEnvelope<T = unknown> {
  readonly eventId: string;
  readonly schemaVersion: 1;
  readonly domain: EventDomain;
  readonly type: string;
  readonly pairing: PairingScope;
  readonly turnId?: string | undefined;
  readonly sourceRef: { readonly id: string; readonly version: number; readonly revision?: number | undefined };
  readonly occurredAt: string;
  readonly receivedAt: string;
  readonly payload: T;
  readonly summary: string;
}

// --- 4. InvitationCandidate ----------------------------------------------------------------------

export type InvitationActionKind = 'text' | 'voice_start' | 'clarify';
export type InvitationStatus = 'pending' | 'accepted' | 'ignored' | 'dismissed' | 'expired';

export interface InvitationCandidate {
  readonly id: string;
  readonly pairing: PairingScope;
  readonly reasonCode: string;
  readonly sourceRef: { readonly kind: 'observation' | 'continuity_fact' | 'schedule'; readonly id: string; readonly version: number };
  readonly text: string;
  readonly actionKind: InvitationActionKind;
  readonly quotaDomain: 'greeting' | 'proactive_topic' | 'work_followup';
  readonly createdAt: string;
  readonly validUntil: string;
  readonly status: InvitationStatus;
}

// --- 5. WorkRequest & WorkReceipt ----------------------------------------------------------------

export type WorkProtocol = 'acp' | 'mcp' | 'internal_harness';
export type WorkExecutionStatus = 'prepared' | 'dispatched' | 'running' | 'succeeded' | 'failed' | 'uncertain' | 'cancelled';

export interface WorkRequest {
  readonly operationId: string;
  /** Monotonic request revision; confirmation must name the exact reviewed revision. */
  readonly revision: number;
  readonly protocol: WorkProtocol;
  readonly executorId: string;
  /** Runtime profile revision reviewed when this request was prepared. */
  readonly executorRevision?: number;
  readonly target: { readonly projectId?: string; readonly directory?: string; readonly title: string };
  readonly instruction: string;
  /** MCP requests bind one discovered tool and exact reviewed arguments to the confirmation revision. */
  readonly toolCall?: { readonly name: string; readonly arguments: Readonly<Record<string, unknown>> };
  readonly permissionGrant: readonly string[];
  readonly requestedAt: string;
}

export interface WorkReceipt {
  readonly operationId: string;
  readonly remoteTaskId?: string;
  readonly status: WorkExecutionStatus;
  readonly updatedAt: string;
  readonly summary?: string;
  readonly error?: { readonly code: string; readonly message: string; readonly retryable: boolean };
}
