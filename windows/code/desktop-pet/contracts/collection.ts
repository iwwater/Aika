/**
 * contracts/collection.ts
 *
 * 0.81 Collection Contracts.
 * Governs Windows continuous desktop observation trial:
 * - Sources: keyboard activity aggregation, screenshot directory watching, clipboard images.
 * - Nonces/Grants: explicit opt-in, paired scopes, bounded TTL, zero plaintext key logging.
 * - Policies: normal vs smoke runtime profiles.
 * - Helper NDJSON control messages and staging interfaces.
 */

import { resolve, normalize } from 'node:path';
import type { PairingScope } from './character-pack.js';

export type CollectionSourceKind = 'keyboard' | 'screenshot_directory' | 'clipboard_image';
export type CollectionGrantState = 'active' | 'paused' | 'stopped' | 'revoked' | 'expired';
export type CollectionProfile = 'normal' | 'smoke';
export type CollectionConfidence = 'verified' | 'candidate' | 'unknown';
/**
 * Image formats a managed sample may hold.
 *
 * BMP is required by the clipboard source: Windows delivers `CF_DIBV5`/`CF_DIB`, which the helper
 * stages as a `.bmp`. Excluding BMP would reject every real clipboard image.
 */
export type SupportedImageMime = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/bmp';

export interface CollectionPolicy {
  readonly schemaVersion: 1;
  readonly profile: CollectionProfile;
  readonly policyVersion: number;
  readonly keyboardBucketMs: number;
  readonly keyboardQuietMs: number;
  readonly afkMs: number;
  readonly ringMaxAgeMs: number;
  readonly ringMaxItems: number;
  readonly sampleRetentionMs: number;
  readonly managedByteLimit: number;
  readonly queueItemLimit: number;
  readonly queueByteLimit: number;
  readonly crossSourceWindowMs: number;
  readonly grantMaxDurationMs: number;
  readonly fileStableIntervalMs: number;
  readonly clipboardRetryLimit: number;
  readonly clipboardRetryBudgetMs: number;
  readonly maxImageBytes: number;
  readonly maxImagePixels: number;
}

export const NORMAL_COLLECTION_POLICY: CollectionPolicy = Object.freeze({
  schemaVersion: 1,
  profile: 'normal',
  policyVersion: 1,
  keyboardBucketMs: 10_000,
  keyboardQuietMs: 5_000,
  afkMs: 300_000,
  ringMaxAgeMs: 180_000,
  ringMaxItems: 1000,
  sampleRetentionMs: 7 * 86_400_000, // 604_800_000 (7 days)
  managedByteLimit: 1024 * 1024 * 1024, // 1 GiB
  queueItemLimit: 32,
  queueByteLimit: 64 * 1024 * 1024, // 64 MiB
  crossSourceWindowMs: 5_000,
  grantMaxDurationMs: 7 * 86_400_000, // 604_800_000 (7 days)
  fileStableIntervalMs: 1_000,
  clipboardRetryLimit: 3,
  clipboardRetryBudgetMs: 1_000,
  maxImageBytes: 20 * 1024 * 1024, // 20 MiB
  maxImagePixels: 40_000_000, // 40 MP
});

export const SMOKE_COLLECTION_POLICY: CollectionPolicy = Object.freeze({
  schemaVersion: 1,
  profile: 'smoke',
  policyVersion: 1,
  keyboardBucketMs: 1_000,
  keyboardQuietMs: 2_000,
  afkMs: 15_000,
  ringMaxAgeMs: 30_000,
  ringMaxItems: 100,
  sampleRetentionMs: 10 * 60_000, // 600_000 (10 min)
  managedByteLimit: 64 * 1024 * 1024, // 64 MiB
  queueItemLimit: 4,
  queueByteLimit: 24 * 1024 * 1024, // 24 MiB
  crossSourceWindowMs: 2_000,
  grantMaxDurationMs: 30 * 60_000, // 1_800_000 (30 min)
  fileStableIntervalMs: 1_000,
  clipboardRetryLimit: 3,
  clipboardRetryBudgetMs: 1_000,
  maxImageBytes: 20 * 1024 * 1024, // 20 MiB
  maxImagePixels: 40_000_000, // 40 MP
});

/**
 * Validate and load policy for the selected profile, ensuring root path isolation.
 */
export function loadCollectionPolicy(
  profile: string,
  dataRoot: string,
  normalDataRoot?: string,
): CollectionPolicy {
  if (typeof profile !== 'string' || (profile !== 'normal' && profile !== 'smoke')) {
    throw new Error(`Invalid collection profile: ${profile}. Must be 'normal' or 'smoke'.`);
  }
  if (!dataRoot || typeof dataRoot !== 'string') {
    throw new Error('Data root path must be a non-empty string.');
  }

  const normalizedDataRoot = normalize(resolve(dataRoot));
  if (profile === 'smoke' && normalDataRoot) {
    const normalizedNormal = normalize(resolve(normalDataRoot));
    if (normalizedDataRoot.toLowerCase() === normalizedNormal.toLowerCase()) {
      throw new Error('Smoke profile must use an independent data root; cannot share normal data root.');
    }
    const relativeToNormal = resolve(normalizedDataRoot).toLowerCase();
    const normalBase = resolve(normalizedNormal).toLowerCase();
    if (relativeToNormal.startsWith(normalBase + '\\') || relativeToNormal.startsWith(normalBase + '/')) {
      throw new Error('Smoke profile data root cannot be a child directory of the normal data root.');
    }
  }

  const basePolicy = profile === 'normal' ? NORMAL_COLLECTION_POLICY : SMOKE_COLLECTION_POLICY;
  validateCollectionPolicy(basePolicy);
  return basePolicy;
}

export function validateCollectionPolicy(policy: CollectionPolicy): void {
  if (policy.schemaVersion !== 1) throw new Error('Unsupported collection policy schema version');
  if (policy.keyboardBucketMs <= 0) throw new Error('keyboardBucketMs must be positive');
  if (policy.keyboardQuietMs <= 0) throw new Error('keyboardQuietMs must be positive');
  if (policy.afkMs <= 0) throw new Error('afkMs must be positive');
  if (policy.sampleRetentionMs <= 0) throw new Error('sampleRetentionMs must be positive');
  if (policy.managedByteLimit <= 0) throw new Error('managedByteLimit must be positive');
  if (policy.queueItemLimit <= 0) throw new Error('queueItemLimit must be positive');
  if (policy.queueByteLimit <= 0) throw new Error('queueByteLimit must be positive');
  if (policy.crossSourceWindowMs <= 0) throw new Error('crossSourceWindowMs must be positive');
  if (policy.grantMaxDurationMs <= 0) throw new Error('grantMaxDurationMs must be positive');
  if (policy.fileStableIntervalMs <= 0) throw new Error('fileStableIntervalMs must be positive');
  if (policy.maxImageBytes > 20 * 1024 * 1024) throw new Error('maxImageBytes exceeds safety limit (20 MiB)');
  if (policy.maxImagePixels > 40_000_000) throw new Error('maxImagePixels exceeds safety limit (40 MP)');
}

// --- 2. Grants -----------------------------------------------------------------------------------

export interface CollectionGrant {
  readonly schemaVersion: 1;
  readonly grantId: string;
  readonly revision: number;
  readonly pairing: PairingScope;
  readonly kind: CollectionSourceKind;
  /** Only present for screenshot_directory, verified with realpath boundary check. */
  readonly directoryRoot?: string;
  readonly purpose: 'local_sample_trial';
  readonly destination: 'local';
  readonly policyVersion: number;
  readonly state: CollectionGrantState;
  readonly grantedAt: string;
  readonly expiresAt: string;
}

// --- 3. Samples ----------------------------------------------------------------------------------

export interface CollectionSampleBase {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly revision: number;
  readonly pairing: PairingScope;
  readonly grantId: string;
  readonly grantRevision: number;
  readonly sourceKind: CollectionSourceKind;
  readonly policyVersion: number;
  readonly occurredAt: string | null;
  readonly receivedAt: string;
  readonly contextObservedAt: string | null;
  readonly expiresAt: string;
  readonly sourceConfidence: CollectionConfidence;
  readonly state: 'active' | 'invalidated';
}

export interface KeyboardActivitySample extends CollectionSampleBase {
  readonly sampleKind: 'keyboard_activity';
  readonly bucketStart: string;
  readonly bucketEnd: string;
  readonly activityCount: number;
  readonly foregroundAppId: string | null;
  readonly afkBoundary: boolean;
  // Strictly prohibited: keyCode, scanCode, character, composition, text sequences.
}

export interface ImageSample extends CollectionSampleBase {
  readonly sampleKind: 'image';
  readonly assetId: string; // Managed internal asset ID only. Never an arbitrary filesystem path.
  readonly mimeType: SupportedImageMime;
  readonly origin: 'directory_candidate' | 'clipboard_unknown' | 'correlated_capture';
  readonly repeated: boolean;
  readonly correlatedSourceIds: readonly string[];
  readonly foregroundAppId: string | null;
}

export type CollectionSample = KeyboardActivitySample | ImageSample;

// --- 4. Query & Status ---------------------------------------------------------------------------

export interface CollectionQuery {
  readonly pairing: PairingScope;
  readonly from: string; // UTC ISO inclusive
  readonly to: string;   // UTC ISO exclusive
  readonly kinds?: readonly CollectionSourceKind[];
  readonly limit: number; // 1..100
  readonly cursor?: string;
}

export interface CollectionPage {
  readonly items: readonly CollectionSample[];
  readonly nextCursor: string | null;
  readonly totalMatching: number;
  readonly collectionRevision: number;
}

export interface CollectionSourceStatus {
  readonly kind: CollectionSourceKind;
  readonly state: CollectionGrantState | 'disabled' | 'unavailable';
  readonly revision: number;
  readonly grantExpiresAt: string | null;
  readonly directoryDisplayPath: string | null;
  readonly lastAcceptedAt: string | null;
  readonly accepted: number;
  readonly duplicates: number;
  readonly rejected: number;
  readonly dropped: number;
  readonly lastErrorCode: string | null;
}

export interface CollectionStatus {
  readonly pairing: PairingScope;
  readonly instanceId: string;
  readonly collectionRevision: number;
  readonly profile: CollectionProfile;
  readonly policyVersion: number;
  readonly policy: CollectionPolicy;
  readonly managedBytes: number;
  readonly queueItems: number;
  readonly queueBytes: number;
  readonly sources: readonly CollectionSourceStatus[];
}

// --- 5. Source Ports & Service Interfaces --------------------------------------------------------

export interface CollectionSourceLease {
  close(): Promise<void>;
}

export interface KeyboardActivityPort {
  start(
    input: { readonly grantId: string; readonly policy: CollectionPolicy; readonly grantRevision: number },
    onActivity: (value: {
      readonly bucketStart: string;
      readonly bucketEnd: string;
      readonly activityCount: number;
      readonly foregroundAppId: string | null;
      readonly afkBoundary: boolean;
      readonly grantRevision: number;
    }) => void,
  ): Promise<CollectionSourceLease>;
}

export interface ScreenshotDirectoryPort {
  start(
    input: { readonly grantId: string; readonly canonicalRoot: string; readonly grantRevision: number },
    onCandidate: (value: {
      readonly opaqueFileRef: string;
      readonly observedAt: string;
      readonly grantRevision: number;
    }) => void,
  ): Promise<CollectionSourceLease>;
  resolveCandidate(
    opaqueFileRef: string,
    grant: CollectionGrant,
  ): Promise<{
    readonly bytes: Uint8Array;
    readonly mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
    readonly fileVersion: string;
    readonly firstSeenAt: string;
    readonly stableAt: string;
  } | null>;
}

export interface ClipboardImagePort {
  start(
    input: { readonly grantId: string; readonly grantRevision: number },
    onChange: (value: {
      readonly clipboardSequence: number;
      readonly observedAt: string;
      readonly grantRevision: number;
    }) => void,
  ): Promise<CollectionSourceLease>;
  readImageIfCurrent(sequence: number): Promise<{ readonly bytes: Uint8Array; readonly mimeType: string } | null>;
}

export interface CollectionServicePort {
  status(pairing: PairingScope): Promise<CollectionStatus>;
  activate(input: {
    readonly pairing: PairingScope;
    readonly kind: CollectionSourceKind;
    readonly directoryRoot?: string;
    readonly expiresAt: string;
    readonly expectedRevision: number;
    readonly operationId: string;
  }): Promise<CollectionStatus>;
  transition(input: {
    readonly pairing: PairingScope;
    readonly kind: CollectionSourceKind;
    readonly action: 'pause' | 'resume' | 'stop' | 'revoke';
    readonly expectedRevision: number;
    readonly operationId: string;
  }): Promise<CollectionStatus>;
  list(query: CollectionQuery): Promise<CollectionPage>;
  readAsset(input: {
    readonly pairing: PairingScope;
    readonly sampleId: string;
    readonly variant: 'thumbnail' | 'original';
  }): Promise<{ readonly bytes: Uint8Array; readonly mimeType: string } | null>;
  feedback(input: {
    readonly pairing: PairingScope;
    readonly sampleId: string;
    readonly label: 'useful' | 'not_useful' | 'mismatch';
    readonly expectedRevision: number;
    readonly operationId: string;
  }): Promise<{ readonly revision: number }>;
  recordMissing(input: {
    readonly pairing: PairingScope;
    readonly kind: CollectionSourceKind;
    readonly observedAt: string;
    readonly operationId: string;
  }): Promise<{ readonly id: string }>;
  erase(input: {
    readonly pairing: PairingScope;
    readonly scope: 'item' | 'range' | 'all';
    readonly sampleId?: string;
    readonly from?: string;
    readonly to?: string;
    readonly expectedRevision: number;
    readonly operationId: string;
  }): Promise<{ readonly affected: number; readonly revision: number }>;
}

// --- 6. Helper IPC Protocol (NDJSON) -------------------------------------------------------------

export type CollectionHelperControlOp = 'start' | 'stop' | 'read_clipboard_image' | 'close';

export interface CollectionHelperControlMessage {
  readonly schemaVersion: 1;
  readonly instanceId: string;
  readonly requestId: string;
  readonly grantId: string;
  readonly grantRevision: number;
  readonly kind: CollectionSourceKind;
  readonly op: CollectionHelperControlOp;
  readonly sequence?: number;
}

export interface CollectionHelperEventMessage {
  readonly schemaVersion: 1;
  readonly instanceId: string;
  readonly requestId: string;
  readonly grantRevision: number;
  readonly kind: CollectionSourceKind;
  readonly op: 'activity' | 'clipboard_seq' | 'staged_image' | 'error' | 'stopped';
  readonly payload: Record<string, unknown>;
}

export const HELPER_MAX_LINE_LENGTH = 65536; // 64 KiB
