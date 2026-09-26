/**
 * core/collection-service.ts
 *
 * N081-01～05: Collection service.
 *
 * Sits between the source adapters and the durable store. For every source notification it:
 *  1. re-verifies the grant (before capture, before write, before projection),
 *  2. converts the notification into the store's candidate shape,
 *  3. submits with the source's own idempotency key,
 *  4. records health counters so a silent source is visible rather than assumed healthy.
 *
 * It performs no OCR/VLM work, opens no TurnPort, and never invites or promotes memory.
 */

import { randomUUID } from 'node:crypto';
import type { CollectionGrantManager } from './collection-grants.js';
import type { CollectionStore, AppendResult } from '../memory/collection-store.js';
import type { CollectionHelperClient } from './collection-helper-client.js';
import { correlateCapture, type CorrelationCandidate, type CorrelationResult } from './clipboard-image-source.js';
import { correlationDigest } from './screenshot-directory-source.js';
import type { ScreenshotDirectoryPort, ClipboardImagePort, CollectionSourceLease, CollectionStatus, SupportedImageMime } from '../contracts/collection.js';
import type { PairingScope } from '../contracts/character-pack.js';

export interface CollectionServiceOptions {
  readonly grants: CollectionGrantManager;
  readonly store: CollectionStore;
  readonly pairing: PairingScope;
  readonly instanceId: string;
  readonly helper?: CollectionHelperClient;
  readonly screenshotDirectory?: ScreenshotDirectoryPort;
  readonly clipboard?: ClipboardImagePort;
  readonly now?: () => string;
}

/** Sources that are wired into this service, so status can distinguish disabled from unavailable. */
export interface CollectionSourceWiring {
  readonly keyboard: boolean;
  readonly screenshot_directory: boolean;
  readonly clipboard_image: boolean;
}

export class CollectionService {
  private readonly leases = new Map<string, CollectionSourceLease>();
  private closed = false;

  constructor(private readonly options: CollectionServiceOptions) {}

  get wiring(): CollectionSourceWiring {
    return {
      keyboard: this.options.helper !== undefined,
      screenshot_directory: this.options.screenshotDirectory !== undefined,
      clipboard_image: this.options.helper !== undefined || this.options.clipboard !== undefined,
    };
  }

  /**
   * Status for the current pairing. A source with no grant reports `disabled`; a source with a
   * grant but no adapter reports `unavailable`. Neither is ever shown as healthy.
   */
  status(): CollectionStatus {
    const { store, pairing, instanceId } = this.options;
    const wiring = this.wiring;
    const base = store.status(pairing, instanceId, kind =>
      this.options.grants.available ? this.options.grants.current(pairing, kind) : null);
    const sources = base.sources.map(source => {
      const wired = source.kind === 'keyboard' ? wiring.keyboard
        : source.kind === 'screenshot_directory' ? wiring.screenshot_directory
        : wiring.clipboard_image;
      if (wired) return source;
      // An unwired source is unavailable, not disabled: the difference matters to the user.
      return { ...source, state: source.state === 'disabled' ? 'unavailable' as const : source.state };
    });
    return Object.freeze({ ...base, sources: Object.freeze(sources) });
  }

  /** Start one source. The grant must already be active; this only opens the listener. */
  async startSource(kind: 'keyboard' | 'screenshot_directory' | 'clipboard_image'): Promise<void> {
    if (this.closed) throw new Error('collection_service_closed');
    const { grants, pairing, store } = this.options;
    const grant = grants.current(pairing, kind);
    if (!grant) throw new Error('collection_source_not_authorized');
    if (grant.state !== 'active') throw new Error('collection_source_not_active');

    if (kind === 'keyboard') {
      const helper = this.options.helper;
      if (!helper) throw new Error('keyboard_source_unavailable');
      helper.start();
      await helper.startKeyboard({ grantId: grant.grantId, grantRevision: grant.revision, policy: store.policy });
      await grants.attachLease({
        kind, grantId: grant.grantId, grantRevision: grant.revision,
        release: async () => { await helper.stopKeyboard({ grantId: grant.grantId, grantRevision: grant.revision }); },
      });
      return;
    }

    if (kind === 'screenshot_directory') {
      const port = this.options.screenshotDirectory;
      if (!port) throw new Error('screenshot_directory_source_unavailable');
      if (!grant.directoryRoot) throw new Error('directory_required');
      const lease = await port.start(
        { grantId: grant.grantId, canonicalRoot: grant.directoryRoot, grantRevision: grant.revision },
        // The port was opened for exactly this grant, so its identity is bound here rather than
        // trusted from the callback payload.
        candidate => { void this.onDirectoryCandidate({ ...candidate, grantId: grant.grantId }); },
      );
      this.leases.set(`${kind}:${grant.grantId}`, lease);
      await grants.attachLease({ kind, grantId: grant.grantId, grantRevision: grant.revision, release: () => lease.close() });
      return;
    }

    const helper = this.options.helper;
    const port = this.options.clipboard;
    if (helper) {
      helper.start();
      await helper.startClipboard({ grantId: grant.grantId, grantRevision: grant.revision });
      await grants.attachLease({
        kind, grantId: grant.grantId, grantRevision: grant.revision,
        release: async () => { helper.stopClipboard({ grantId: grant.grantId, grantRevision: grant.revision }); helper.clearStaging(); },
      });
      return;
    }
    if (!port) throw new Error('clipboard_source_unavailable');
    const lease = await port.start({ grantId: grant.grantId, grantRevision: grant.revision },
      change => { void this.onClipboardChange({ ...change, grantId: grant.grantId }); });
    this.leases.set(`${kind}:${grant.grantId}`, lease);
    await grants.attachLease({ kind, grantId: grant.grantId, grantRevision: grant.revision, release: () => lease.close() });
  }

  /** P1-1: Stop one source listener and release its lease. Other sources continue. */
  async stopSource(kind: 'keyboard' | 'screenshot_directory' | 'clipboard_image'): Promise<void> {
    const { grants } = this.options;
    await grants.releaseLease(kind).catch(() => undefined);
    for (const [key, lease] of [...this.leases]) {
      if (key.startsWith(`${kind}:`)) {
        this.leases.delete(key);
        await lease.close().catch(() => undefined);
      }
    }
  }

  // --- inbound notifications ---------------------------------------------------------------------

  /**
   * Handle one aggregated keyboard bucket from the helper.
   *
   * The payload carries counts only. This method is also the gate that refuses a bucket whose
   * grant revision has already been superseded, so a late callback cannot be written.
   */
  async onKeyboardActivity(value: {
    readonly grantId: string; readonly grantRevision: number;
    readonly bucketStart: string; readonly bucketEnd: string; readonly activityCount: number;
    readonly foregroundAppId: string | null; readonly afkBoundary: boolean;
  }): Promise<AppendResult | null> {
    const { grants, store, pairing } = this.options;
    if (this.closed) return null;
    if (!Number.isFinite(value.activityCount) || value.activityCount <= 0) return null;
    // A refused callback is DROPPED, never thrown: an adapter callback must not be able to raise
    // into a listener loop. Paused/revoked/expired/stale all resolve to "no evidence written".
    if (!this.#accepts(value.grantId, value.grantRevision, 'keyboard')) return null;
    const grant = grants.current(pairing, 'keyboard');
    if (!grant) return null;
    // The idempotency key is the source's own notification identity, never a content hash.
    const key = `${grant.grantId}|${grant.revision}|${value.bucketStart}|${store.policy.policyVersion}`;
    return store.appendKeyboard(grant, {
      bucketStart: value.bucketStart, bucketEnd: value.bucketEnd, activityCount: value.activityCount,
      foregroundAppId: value.foregroundAppId, afkBoundary: value.afkBoundary,
      // A trustworthy occurredAt is available for a live bucket; otherwise the store uses receivedAt.
      occurredAt: value.bucketStart, contextObservedAt: value.afkBoundary ? null : value.bucketEnd,
    }, key);
  }

  /** True only when the grant is active at exactly this revision for this pairing. */
  #accepts(grantId: string, grantRevision: number, kind: 'keyboard' | 'screenshot_directory' | 'clipboard_image'): boolean {
    const { grants, pairing } = this.options;
    if (!grants.available) return false;
    try {
      grants.assertActive({ grantId, grantRevision, pairing, kind });
      return true;
    } catch { return false; }
  }

  /** Handle one directory file candidate: verify the grant, then read and store stable bytes. */
  async onDirectoryCandidate(value: {
    readonly grantId: string; readonly grantRevision: number;
    readonly opaqueFileRef: string; readonly observedAt: string;
  }): Promise<AppendResult | null> {
    const { grants, store, pairing, screenshotDirectory } = this.options;
    if (this.closed || !screenshotDirectory) return null;
    let grant;
    try {
      grant = grants.assertActive({ grantId: value.grantId, grantRevision: value.grantRevision, pairing, kind: 'screenshot_directory' });
    } catch {
      // A paused/revoked/superseded candidate is dropped without touching the store.
      return null;
    }
    const resolved = await screenshotDirectory.resolveCandidate(value.opaqueFileRef, grant).catch(() => null);
    if (!resolved) return null;
    // Re-verify immediately before the write: the grant may have changed during the stable read.
    try {
      grants.assertActive({ grantId: value.grantId, grantRevision: value.grantRevision, pairing, kind: 'screenshot_directory' });
    } catch { return null; }
    const result = store.appendImage(grant, {
      bytes: resolved.bytes, mimeType: resolved.mimeType, origin: 'directory_candidate',
      occurredAt: resolved.firstSeenAt, contextObservedAt: resolved.stableAt, foregroundAppId: null,
    }, `${grant.grantId}|${grant.revision}|${resolved.fileVersion}`);

    if (result.outcome === 'inserted' && result.sampleId) {
      this.#correlateAndAnnotate({
        sampleId: result.sampleId,
        sourceKind: 'screenshot_directory',
        digest: correlationDigest(resolved.bytes),
        observedAt: resolved.stableAt ?? resolved.firstSeenAt ?? new Date().toISOString(),
      });
    }
    return result;
  }

  /** Handle one clipboard change notification: read the staged image once and store it. */
  async onClipboardChange(value: {
    readonly grantId: string; readonly grantRevision: number;
    readonly clipboardSequence: number; readonly observedAt: string;
  }): Promise<AppendResult | null> {
    const { grants, store, pairing, helper, clipboard } = this.options;
    if (this.closed) return null;
    let grant;
    try {
      grant = grants.assertActive({ grantId: value.grantId, grantRevision: value.grantRevision, pairing, kind: 'clipboard_image' });
    } catch { return null; }

    let bytes: Uint8Array | null = null;
    let mimeType = '';
    if (helper) {
      const staged = await helper.readClipboardImage({
        grantId: grant.grantId, grantRevision: grant.revision, sequence: value.clipboardSequence,
      }).catch(() => null);
      if (!staged) return null;
      const consumed = helper.consumeStagedAsset(staged.stagedAssetId);
      if (!consumed) return null;
      bytes = consumed.bytes;
      mimeType = consumed.mimeType;
    } else if (clipboard) {
      const read = await clipboard.readImageIfCurrent(value.clipboardSequence).catch(() => null);
      if (!read) return null;
      bytes = read.bytes;
      mimeType = read.mimeType;
    } else return null;

    try {
      grants.assertActive({ grantId: value.grantId, grantRevision: value.grantRevision, pairing, kind: 'clipboard_image' });
    } catch { return null; }

    // A clipboard image cannot be distinguished from a copied web image: origin stays unknown.
    const result = store.appendImage(grant, {
      bytes, mimeType: normalizeMime(mimeType), origin: 'clipboard_unknown',
      occurredAt: null, contextObservedAt: value.observedAt, foregroundAppId: null,
    }, `${grant.grantId}|${grant.revision}|${value.clipboardSequence}`);

    if (result.outcome === 'inserted' && result.sampleId) {
      this.#correlateAndAnnotate({
        sampleId: result.sampleId,
        sourceKind: 'clipboard_image',
        digest: correlationDigest(bytes),
        observedAt: value.observedAt,
      });
    }
    return result;
  }

  /** P1-5: Asynchronously annotate correlation if another channel has an exact match within the window. */
  #correlateAndAnnotate(candidate: CorrelationCandidate): void {
    try {
      const decision = this.correlateImage(candidate);
      if (decision.decision === 'same_capture') {
        this.options.store.annotateCorrelation(this.options.pairing, decision.sampleIds);
      }
    } catch { /* correlation failure must not impede collection */ }
  }

  /** One-turn id used by the desktop bridge to correlate a helper event with a request. */
  nextOperationId(): string { return randomUUID(); }

  /**
   * Correlate a freshly stored image candidate with recent candidates from the OTHER channel.
   *
   * Returns the decision without rewriting the two source records: the underlying evidence stays
   * separable so revoking one source can recompute the projection. The one-to-one requirement is
   * enforced by counting how many siblings share each digest inside the window.
   */
  correlateImage(candidate: CorrelationCandidate): CorrelationResult {
    const { store, pairing } = this.options;
    const policy = store.policy;
    const at = Date.parse(candidate.observedAt);
    const from = new Date((Number.isNaN(at) ? Date.now() : at) - policy.crossSourceWindowMs).toISOString();
    const to = new Date((Number.isNaN(at) ? Date.now() : at) + policy.crossSourceWindowMs).toISOString();
    const page = store.list({ pairing, from, to, limit: 100 });
    const images = page.items.filter(item => item.sampleKind === 'image');
    const others = images.filter(item => item.id !== candidate.sampleId && item.sourceKind !== candidate.sourceKind);
    if (others.length === 0) return { decision: 'separate', sampleIds: [candidate.sampleId], reason: 'no_cross_channel_candidate' };

    let best: CorrelationResult | null = null;
    for (const other of others) {
      const read = store.readAsset(pairing, other.id, 'original');
      if (!read) continue;
      const otherCandidate: CorrelationCandidate = {
        sampleId: other.id,
        sourceKind: other.sourceKind === 'clipboard_image' ? 'clipboard_image' : 'screenshot_directory',
        digest: correlationDigest(read.bytes),
        observedAt: other.receivedAt,
      };
      // Sibling counts make a 1:N digest collision ambiguous rather than a silent merge.
      const sameDigestOnOtherSide = others.filter(item => {
        if (item.id === other.id) return false;
        const sibling = store.readAsset(pairing, item.id, 'original');
        return sibling ? correlationDigest(sibling.bytes) === otherCandidate.digest : false;
      }).length;
      const result = correlateCapture(candidate, otherCandidate, policy, { left: 1, right: 1 + sameDigestOnOtherSide });
      if (result.decision === 'same_capture') return result;
      if (result.decision === 'uncertain' && best?.decision !== 'same_capture') best = result;
      if (!best) best = result;
    }
    return best ?? { decision: 'separate', sampleIds: [candidate.sampleId], reason: 'no_cross_channel_candidate' };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const [, lease] of this.leases) await lease.close().catch(() => undefined);
    this.leases.clear();
    await this.options.helper?.close().catch(() => undefined);
  }
}

/** The helper stages BMP; the store accepts the contract's supported set. */
function normalizeMime(mimeType: string): SupportedImageMime {
  if (mimeType === 'image/jpeg' || mimeType === 'image/jpg') return 'image/jpeg';
  if (mimeType === 'image/webp') return 'image/webp';
  if (mimeType === 'image/bmp') return 'image/bmp';
  return 'image/png';
}
