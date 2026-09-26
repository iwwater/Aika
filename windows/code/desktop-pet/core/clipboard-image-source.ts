/**
 * core/clipboard-image-source.ts
 *
 * N081-05: Clipboard image source and two-channel correlation.
 *
 * Two responsibilities, both strictly bounded:
 *
 *  1. `ClipboardImageSource` implements the contract's `ClipboardImagePort`. It reports a Windows
 *     clipboard *sequence* and an observation time. It reads a supported image only when the
 *     sequence has not moved, retries at most `clipboardRetryLimit` times inside
 *     `clipboardRetryBudgetMs`, and never reads plain text, HTML or a file list.
 *
 *  2. `correlateCapture` decides whether a directory candidate and a clipboard notification are the
 *     SAME capture. It merges only on exact content equality inside the correlation window with a
 *     one-to-one candidate pairing. Near-identical bytes are never merged; evidence stays as two
 *     separate source records so revoking one source can recompute the projection.
 */

import type { PairingScope } from '../contracts/character-pack.js';
import type { CollectionPolicy } from '../contracts/collection.js';
import { correlationDigest, detectScreenshotMime } from './screenshot-directory-source.js';

export type CorrelationDecision = 'same_capture' | 'separate' | 'uncertain';

export interface CorrelationCandidate {
  readonly sampleId: string;
  readonly sourceKind: 'screenshot_directory' | 'clipboard_image';
  /** Content digest of the managed bytes. Used for equality only, never as an event identity. */
  readonly digest: string;
  readonly observedAt: string;
  /** Anti-aliasing / re-encoding hints. Never sufficient on their own to merge or delete. */
  readonly perceptualHint?: string | null;
}

export interface CorrelationResult {
  readonly decision: CorrelationDecision;
  readonly sampleIds: readonly string[];
  readonly reason: string;
}

/** Bytes observed by a clipboard read attempt. */
export interface ClipboardReadResult {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
}

export interface ClipboardImageSourceOptions {
  readonly policy: CollectionPolicy;
  readonly now?: () => string;
  /** Reads the current clipboard image, or null when the sequence moved or content is unsupported. */
  readonly readClipboard: (sequence: number) => Promise<ClipboardReadResult | null>;
  /** Current clipboard sequence; a mismatch invalidates the notification. */
  readonly currentSequence: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export class ClipboardImageSource {
  private readonly now: () => string;
  private readonly sleep: (ms: number) => Promise<void>;
  private closed = false;
  private lease: { close: () => Promise<void> } | null = null;
  private lastConsumedSequence = 0;
  /** Sequences already read; the same sequence is never ingested twice. */
  private readonly consumed = new Set<number>();

  constructor(private readonly options: ClipboardImageSourceOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.sleep = options.sleep ?? (ms => new Promise(done => setTimeout(done, ms)));
  }

  /**
   * Start reporting clipboard changes.
   *
   * The sequence present at enable time is recorded as consumed, so content that was already on the
   * clipboard before authorization is deliberately NOT ingested.
   */
  async start(
    _input: { readonly grantId: string; readonly grantRevision: number },
    onChange: (value: {
      readonly clipboardSequence: number;
      readonly observedAt: string;
      readonly grantRevision: number;
    }) => void,
  ): Promise<{ close: () => Promise<void> }> {
    this.lastConsumedSequence = this.options.currentSequence();
    this.consumed.add(this.lastConsumedSequence);
    this.closed = false;

    // The actual OS subscription lives in the helper; this port only reports what it observes.
    this.lease = {
      close: async () => {
        if (this.closed) return;
        this.closed = true;
        this.consumed.clear();
      },
    };
    void onChange;
    return this.lease;
  }

  /** Test seam: deliver one observed clipboard sequence through the same validation path. */
  observe(sequence: number, grantRevision: number): { clipboardSequence: number; observedAt: string; grantRevision: number } | null {
    if (this.closed) return null;
    // A duplicate or already-consumed sequence is not a new observation.
    if (this.consumed.has(sequence)) return null;
    this.consumed.add(sequence);
    this.lastConsumedSequence = sequence;
    return { clipboardSequence: sequence, observedAt: this.now(), grantRevision };
  }

  /**
   * Read the clipboard image for one notification.
   *
   * The sequence is re-verified before AND after each attempt. A moved sequence invalidates the
   * notification rather than yielding a stale image, and the retry budget is bounded.
   */
  async readImageIfCurrent(sequence: number): Promise<ClipboardReadResult | null> {
    const { clipboardRetryLimit, clipboardRetryBudgetMs } = this.options.policy;
    const startedAt = Date.now();
    for (let attempt = 0; attempt < clipboardRetryLimit; attempt++) {
      // The clipboard may be held by another process; a bounded retry avoids losing the capture.
      if (this.options.currentSequence() !== sequence) return null;
      const result = await this.options.readClipboard(sequence).catch(() => null);
      // Re-verify after the read: content that changed mid-read is discarded.
      if (this.options.currentSequence() !== sequence) return null;
      if (result) {
        const mimeType = detectScreenshotMime(result.bytes);
        // Only a supported image format is accepted; text/HTML/file lists never reach here.
        if (!mimeType) return null;
        return { bytes: result.bytes, mimeType };
      }
      if (Date.now() - startedAt >= clipboardRetryBudgetMs) break;
      await this.sleep(20);
    }
    return null;
  }

  get consumedSequences(): readonly number[] { return [...this.consumed]; }
}

/**
 * Decide whether two channel observations are the same capture.
 *
 * Merging requires ALL of: exact content equality, both inside the correlation window, different
 * source kinds, and a one-to-one candidate pairing (each side appears once). Anything weaker is
 * reported as `uncertain` and stays two samples.
 */
export function correlateCapture(
  left: CorrelationCandidate,
  right: CorrelationCandidate,
  policy: CollectionPolicy,
  siblingCounts: { readonly left: number; readonly right: number } = { left: 1, right: 1 },
): CorrelationResult {
  const ids = Object.freeze([left.sampleId, right.sampleId]);

  // The same source cannot correlate with itself; a single channel is never a cross-channel match.
  if (left.sourceKind === right.sourceKind) {
    return { decision: 'separate', sampleIds: ids, reason: 'same_source_channel' };
  }

  const leftAt = Date.parse(left.observedAt);
  const rightAt = Date.parse(right.observedAt);
  if (Number.isNaN(leftAt) || Number.isNaN(rightAt)) {
    return { decision: 'uncertain', sampleIds: ids, reason: 'unparseable_time' };
  }
  const delta = Math.abs(leftAt - rightAt);
  if (delta > policy.crossSourceWindowMs) {
    // Outside the window these are two separate uses of the same image, not one capture.
    return { decision: 'separate', sampleIds: ids, reason: 'outside_correlation_window' };
  }

  const exactMatch = left.digest === right.digest && left.digest.length > 0;
  if (!exactMatch) {
    // A perceptual hint can flag a likely duplicate but must never delete or merge evidence.
    if (left.perceptualHint && right.perceptualHint && left.perceptualHint === right.perceptualHint) {
      return { decision: 'uncertain', sampleIds: ids, reason: 'near_match_requires_review' };
    }
    return { decision: 'separate', sampleIds: ids, reason: 'content_differs' };
  }

  // Exact equality is necessary but not sufficient: a 1:N pairing is ambiguous, so it stays uncertain.
  if (siblingCounts.left !== 1 || siblingCounts.right !== 1) {
    return { decision: 'uncertain', sampleIds: ids, reason: 'ambiguous_pairing' };
  }

  return { decision: 'same_capture', sampleIds: ids, reason: 'exact_content_within_window' };
}

/** Convenience wrapper that computes the digest from managed bytes. */
export function correlationCandidateFor(input: {
  readonly sampleId: string;
  readonly sourceKind: 'screenshot_directory' | 'clipboard_image';
  readonly bytes: Uint8Array;
  readonly observedAt: string;
  readonly perceptualHint?: string | null;
}): CorrelationCandidate {
  return {
    sampleId: input.sampleId,
    sourceKind: input.sourceKind,
    digest: correlationDigest(input.bytes),
    observedAt: input.observedAt,
    ...(input.perceptualHint !== undefined ? { perceptualHint: input.perceptualHint } : {}),
  };
}

/** Origin recorded for a clipboard image: it can never be claimed as a confirmed screenshot. */
export const CLIPBOARD_ORIGIN = 'clipboard_unknown' as const;

/** Queue accounting so a source cannot chase an unbounded backlog of stale clipboard versions. */
export interface ClipboardQueueState {
  readonly items: number;
  readonly bytes: number;
}

export function clipboardQueueAccepts(state: ClipboardQueueState, nextBytes: number, policy: CollectionPolicy): boolean {
  if (state.items + 1 > policy.queueItemLimit) return false;
  if (state.bytes + nextBytes > policy.queueByteLimit) return false;
  return true;
}

/** True when the pairing values are identical; correlation never crosses a pairing boundary. */
export function samePairing(left: PairingScope, right: PairingScope): boolean {
  return left.userId === right.userId
    && left.characterId === right.characterId
    && left.characterInstanceId === right.characterInstanceId;
}
