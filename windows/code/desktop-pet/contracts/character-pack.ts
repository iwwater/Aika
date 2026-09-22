// N07-01: Character Pack Draft and Source Snapshot contracts.
// Strictly scoped to text continuity: local TXT/Markdown source snapshots, stable block locators,
// evidence validation, immutable draft persistence, and distillation inputs/outputs.

export type DraftStatus = 'draft' | 'validated' | 'rejected';

export interface SourceBlockLocator {
  /** 0-based Unicode code point start offset in the source document. */
  readonly start: number;
  /** 0-based Unicode code point end offset in the source document. */
  readonly end: number;
  readonly chapter?: string | undefined;
  readonly line?: number | undefined;
}

export interface SourceBlock {
  /** Stable unique identifier within the snapshot, e.g. `${sourceId}:b${ordinal}`. */
  readonly id: string;
  readonly sourceId: string;
  readonly ordinal: number;
  readonly text: string;
  readonly blockHash: string;
  readonly locator: SourceBlockLocator;
}

export interface SourceSnapshot {
  readonly id: string;
  readonly characterId: string;
  readonly sourceName: string;
  readonly contentHash: string;
  readonly byteLength: number;
  readonly createdAt: string;
  readonly blocks: readonly SourceBlock[];
}

export interface SourceImportInput {
  readonly sourceName: string;
  readonly text: string;
}

export interface SourceLimits {
  readonly acceptedExtensions: readonly string[];
  readonly maxDocumentBytes: number;
  readonly maxFilesPerImport: number;
  readonly maxBlockCodePoints: number;
}

export const DEFAULT_SOURCE_LIMITS: SourceLimits = Object.freeze({
  acceptedExtensions: ['.txt', '.md', '.markdown'],
  maxDocumentBytes: 2 * 1024 * 1024, // 2MB
  maxFilesPerImport: 20,
  maxBlockCodePoints: 800,
});

export interface CanonFact {
  readonly id: string;
  readonly text: string;
  /** Evidence citations pointing back to SourceBlock.id values in the source snapshots. */
  readonly evidenceIds: readonly string[];
  readonly status?: 'explicit' | 'inferred' | 'disputed' | undefined;
}

export interface CharacterSoulDraft {
  readonly name: string;
  readonly soul: string;
  readonly styleHints?: readonly string[] | undefined;
  readonly evidenceIds?: readonly string[] | undefined;
}

export interface CharacterPackDraftPayload {
  readonly schemaVersion: string;
  readonly character: CharacterSoulDraft;
  readonly canonFacts: readonly CanonFact[];
  readonly gaps: readonly string[];
  readonly workTitle?: string | undefined;
  readonly cutoffPoint?: string | undefined;
}

export interface DraftValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
  readonly validatedAt: string;
}

export interface CharacterPackDraft {
  readonly id: string;
  readonly characterId: string;
  readonly packVersion: string;
  readonly schemaVersion: string;
  readonly status: DraftStatus;
  readonly payload: CharacterPackDraftPayload;
  readonly sourceIds: readonly string[];
  readonly validation: DraftValidationResult;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DistillInput {
  readonly characterId: string;
  readonly characterName?: string | undefined;
  readonly sources: readonly SourceSnapshot[];
  readonly cutoffPoint?: string | undefined;
  readonly workTitle?: string | undefined;
  readonly instructions?: string | undefined;
  readonly maxTokens?: number | undefined;
  readonly temperature?: number | undefined;
}

export type CharacterPackErrorCode =
  | 'invalid_request'
  | 'not_found'
  | 'version_conflict'
  | 'validation_failed'
  | 'source_limit_exceeded'
  | 'source_fetch_failed'
  | 'unsupported_source'
  | 'cutoff_violation'
  | 'aborted';

export class CharacterPackError extends Error {
  constructor(readonly code: CharacterPackErrorCode, message: string) {
    super(message);
    this.name = 'CharacterPackError';
  }
}

export type SourceKind = 'text' | 'file' | 'http_wiki';

export interface CharacterSourceRef {
  readonly kind: SourceKind;
  /** File path, HTTP(S) URL, or descriptive identifier */
  readonly uri: string;
  readonly title?: string | undefined;
  /** Direct inline text for 'text' kind */
  readonly text?: string | undefined;
}

export interface FetchSourceResult {
  readonly sourceName: string;
  readonly text: string;
  readonly kind: SourceKind;
  readonly uri: string;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}

export interface CharacterSourceProvider {
  canHandle(ref: CharacterSourceRef): boolean;
  fetch(ref: CharacterSourceRef, signal?: AbortSignal): Promise<FetchSourceResult>;
}

// --- N07-03 Continuity, Activation, Instances, and Timelines -----------------

export type CanonAwareness = 'experienced' | 'heard' | 'unknown';

export interface CanonTimelineEvent {
  readonly eventId: string;
  readonly ordinal: number;
  readonly summary: string;
  readonly charactersInvolved: readonly string[];
  readonly awareness: CanonAwareness;
  readonly chapter?: string | undefined;
  readonly evidenceIds: readonly string[];
  readonly status: 'explicit' | 'inferred' | 'disputed';
}

export interface CharacterPack {
  readonly id: string;
  readonly characterId: string;
  readonly packVersion: string;
  readonly schemaVersion: string;
  readonly name: string;
  readonly soul: string;
  readonly styleHints?: readonly string[] | undefined;
  readonly canonFacts: readonly CanonFact[];
  readonly canonTimeline: readonly CanonTimelineEvent[];
  readonly gaps: readonly string[];
  readonly sourceIds: readonly string[];
  readonly sourceHashes: readonly string[];
  readonly cutoffPoint?: string | undefined;
  readonly workTitle?: string | undefined;
  readonly draftId?: string | undefined;
  readonly activatedAt?: string | undefined;
  readonly createdAt: string;
}

export interface PairingScope {
  readonly userId: string;
  readonly characterId: string;
  readonly characterInstanceId: string;
}

export interface CharacterInstance {
  readonly instanceId: string;
  readonly userId: string;
  readonly characterId: string;
  readonly activePackId: string | null;
  readonly activePackVersion: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CompanionTimelineEvent {
  readonly eventId: string;
  readonly userId: string;
  readonly characterId: string;
  readonly characterInstanceId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly userText: string;
  readonly assistantText: string;
  readonly createdAt: string;
  /** Continuity/User Soul/Wiki facts derived from this interaction; revoked facts suppress this event from Context. */
  readonly sourceIds?: readonly string[] | undefined;
}

export interface ContinuitySnapshot {
  readonly pairing: PairingScope;
  readonly activePack: CharacterPack | null;
  readonly canonTimeline: readonly CanonTimelineEvent[];
  readonly companionTimeline: readonly CompanionTimelineEvent[];
  readonly packRevision: number;
}

export interface ContinuityReadPort {
  getSnapshot(
    pairing: PairingScope,
    options?: {
      readonly cutoffPoint?: string | undefined;
      readonly maxCanonEvents?: number | undefined;
      readonly maxCompanionEvents?: number | undefined;
      readonly awarenessFilter?: readonly CanonAwareness[] | undefined;
    },
  ): Promise<ContinuitySnapshot>;
}
