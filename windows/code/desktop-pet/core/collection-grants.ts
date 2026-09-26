/**
 * core/collection-grants.ts
 *
 * N081-01: Collection Source Grant Manager.
 *
 * Owns the *state machine* for continuous desktop-collection authorization:
 * keyboard activity, a specific screenshot directory, and clipboard images.
 *
 * Deliberately separate from the 0.8 single-frame `CaptureGrantManager`:
 *  - 0.8 grants are 2-minute, single/session scoped screen captures for one Observation.
 *  - Collection grants are long-lived (normal 7d / smoke 30min), per source kind, and are the
 *    only credential a continuous listener may present.
 * The two never upgrade into each other.
 *
 * Persistence: this class holds no durable authority of its own. It reads and writes through an
 * injected `CollectionGrantStorePort`, which N081-02 implements over the single SQLite owner.
 * Without a store the manager refuses to issue (`collection_store_unavailable`) rather than
 * running on in-memory state that a restart would silently resurrect or drop.
 */

import { randomUUID } from 'node:crypto';
import type { PairingScope } from '../contracts/character-pack.js';
import type {
  CollectionGrant,
  CollectionGrantState,
  CollectionPolicy,
  CollectionSourceKind,
} from '../contracts/collection.js';

export type CollectionGrantErrorCode =
  | 'invalid_request'
  | 'forbidden'
  | 'version_conflict'
  | 'not_found'
  | 'expired'
  | 'revoked'
  | 'directory_required'
  | 'directory_forbidden'
  | 'directory_boundary'
  | 'pairing_mismatch'
  | 'store_unavailable';

export class CollectionGrantError extends Error {
  constructor(readonly code: CollectionGrantErrorCode, message: string) {
    super(message);
    this.name = 'CollectionGrantError';
  }
}

/** Durable record owned by N081-02. The manager never keeps a second copy. */
export interface CollectionGrantRecord {
  readonly grantId: string;
  readonly revision: number;
  readonly pairing: PairingScope;
  readonly kind: CollectionSourceKind;
  readonly directoryRoot: string | null;
  readonly purpose: 'local_sample_trial';
  readonly destination: 'local';
  readonly policyVersion: number;
  readonly state: CollectionGrantState;
  readonly grantedAt: string;
  readonly expiresAt: string;
}

export interface CollectionGrantStorePort {
  /** Current record for one pairing+kind, or null when the source was never authorized. */
  current(pairing: PairingScope, kind: CollectionSourceKind): CollectionGrantRecord | null;
  /**
   * Insert the first revision of a grant. Returns the stored record.
   * Must reject a duplicate grantId instead of silently replacing it.
   */
  insert(record: CollectionGrantRecord): CollectionGrantRecord;
  /**
   * Compare-and-set on revision. `expectedRevision` is the revision the caller observed.
   * Must throw a conflict error when it no longer matches, so two consoles cannot both win.
   * `expiresAt` / `directoryRoot` are patched when present so a persisted record never diverges
   * from what the manager returned to the caller.
   */
  update(input: {
    readonly grantId: string;
    readonly expectedRevision: number;
    readonly state: CollectionGrantState;
    readonly revision: number;
    readonly expiresAt?: string;
    readonly directoryRoot?: string | null;
    readonly policyVersion?: number;
  }): CollectionGrantRecord;
}

export interface CollectionGrantManagerOptions {
  /**
   * The store is mandatory for issuance. `undefined` keeps the manager in an explicitly
   * unavailable state (used by component tests that assert the refusal path).
   */
  readonly store?: CollectionGrantStorePort;
  readonly policy: CollectionPolicy;
  readonly now?: () => string;
  readonly newGrantId?: () => string;
}

/** Reasons a listener must stop immediately. */
export type CollectionRevokeReason =
  | 'paused'
  | 'stopped'
  | 'revoked'
  | 'expired'
  | 'session_locked'
  | 'pack_disabled'
  | 'instance_changed'
  | 'closed';

export interface CollectionLeaseBinding {
  readonly kind: CollectionSourceKind;
  readonly grantId: string;
  readonly grantRevision: number;
  readonly release: () => void | Promise<void>;
}

export interface HostReleaseRegistrar {
  register(kind: 'listener' | 'process' | 'file-handle' | 'worker', id: string, release: () => void | Promise<void>): void;
  release(id: string): Promise<void>;
  readonly outstanding: readonly string[];
}

export class CollectionGrantManager {
  private readonly listeners = new Set<(grant: CollectionGrant, reason: CollectionRevokeReason) => void>();
  /** At most one live lease per source kind; a second start replaces nothing. */
  private readonly leases = new Map<CollectionSourceKind, CollectionLeaseBinding>();
  private closed = false;

  constructor(private readonly options: CollectionGrantManagerOptions) {}

  get available(): boolean { return !this.closed && this.options.store !== undefined; }

  onRevoke(listener: (grant: CollectionGrant, reason: CollectionRevokeReason) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Current grant for a source, after lazily marking an elapsed grant as expired. */
  current(pairing: PairingScope, kind: CollectionSourceKind): CollectionGrant | null {
    const store = this.#store();
    const record = store.current(pairing, kind);
    if (!record) return null;
    if (this.#isExpired(record) && (record.state === 'active' || record.state === 'paused')) {
      // Expiry stops NEW collection only; samples keep their own expiresAt and TTL.
      return this.#toGrant(store.update({
        grantId: record.grantId,
        expectedRevision: record.revision,
        state: 'expired',
        revision: record.revision + 1,
      }));
    }
    return this.#toGrant(record);
  }

  /**
   * Issue or re-issue authorization for one source kind.
   *
   * `expectedRevision` is the revision the caller last observed; `0` means "no grant yet".
   * Changing the directory, pairing, purpose or destination invalidates the old grant: the
   * caller must pass revision 0 after a directory change instead of mutating an active grant.
   */
  issue(input: {
    readonly pairing: PairingScope;
    readonly kind: CollectionSourceKind;
    readonly directoryRoot?: string;
    readonly expiresAt: string;
    readonly expectedRevision: number;
    readonly operationId: string;
  }): CollectionGrant {
    this.#open();
    const store = this.#store();
    if (!input.operationId?.trim()) throw new CollectionGrantError('invalid_request', 'operationId is required');
    const now = this.#now();

    if (input.kind === 'screenshot_directory') {
      if (typeof input.directoryRoot !== 'string' || !input.directoryRoot.trim()) {
        throw new CollectionGrantError('directory_required', 'A screenshot directory source requires an explicit directory.');
      }
    } else if (input.directoryRoot !== undefined) {
      throw new CollectionGrantError('directory_forbidden', 'Only a screenshot directory source may carry a directory.');
    }

    const expiresAt = this.#validatedExpiry(input.expiresAt, now);
    const existing = store.current(input.pairing, input.kind);

    if (existing && input.expectedRevision === 0) {
      // A caller believing nothing is authorized must not silently overwrite a live grant.
      throw new CollectionGrantError('version_conflict', 'A grant already exists for this source; supply its current revision.');
    }

    if (!existing) {
      if (input.expectedRevision !== 0) {
        throw new CollectionGrantError('version_conflict', 'expectedRevision does not match: no grant exists for this source.');
      }
      const record: CollectionGrantRecord = {
        grantId: this.options.newGrantId?.() ?? randomUUID(),
        revision: 1,
        pairing: input.pairing,
        kind: input.kind,
        directoryRoot: input.kind === 'screenshot_directory' ? (input.directoryRoot ?? '').trim() : null,
        purpose: 'local_sample_trial',
        destination: 'local',
        policyVersion: this.options.policy.policyVersion,
        state: 'active',
        grantedAt: now,
        expiresAt,
      };
      return this.#toGrant(store.insert(record));
    }

    if (existing.revision !== input.expectedRevision) {
      throw new CollectionGrantError('version_conflict', 'expectedRevision is stale; re-read the source status first.');
    }
    if (existing.state === 'revoked') {
      // P1-4: A revoked source can be re-authorized by issuing a new grant in place.
      const next = store.update({
        grantId: existing.grantId,
        expectedRevision: existing.revision,
        state: 'active',
        revision: existing.revision + 1,
        expiresAt,
        policyVersion: this.options.policy.policyVersion,
        ...(input.kind === 'screenshot_directory' ? { directoryRoot: (input.directoryRoot ?? '').trim() } : {}),
      });
      return this.#toGrant(next);
    }
    // Re-issuing on an active/paused/stopped/expired grant refreshes state, expiry and policy in place.
    // The scope itself (kind, pairing) is immutable here; a different directory needs a new grant.
    const next = store.update({
      grantId: existing.grantId,
      expectedRevision: existing.revision,
      state: 'active',
      revision: existing.revision + 1,
      expiresAt,
      policyVersion: this.options.policy.policyVersion,
    });
    return this.#toGrant(next);
  }

  /**
   * pause | resume | stop | revoke. Every transition increments revision.
   * `resume` only restores the SAME still-valid scope; a changed directory or pairing needs issue().
   */
  transition(input: {
    readonly pairing: PairingScope;
    readonly kind: CollectionSourceKind;
    readonly action: 'pause' | 'resume' | 'stop' | 'revoke';
    readonly expectedRevision: number;
    readonly operationId: string;
  }): CollectionGrant {
    this.#open();
    const store = this.#store();
    if (!input.operationId?.trim()) throw new CollectionGrantError('invalid_request', 'operationId is required');
    const existing = store.current(input.pairing, input.kind);
    if (!existing) throw new CollectionGrantError('not_found', 'No authorization exists for this source.');
    if (existing.revision !== input.expectedRevision) {
      throw new CollectionGrantError('version_conflict', 'expectedRevision is stale; re-read the source status first.');
    }

    let target: CollectionGrantState;
    let reason: CollectionRevokeReason | undefined;
    switch (input.action) {
      case 'pause':
        if (existing.state !== 'active') throw new CollectionGrantError('invalid_request', 'Only an active source can be paused.');
        target = 'paused'; reason = 'paused'; break;
      case 'resume':
        if (existing.state !== 'paused') throw new CollectionGrantError('invalid_request', 'Only a paused source can be resumed.');
        if (this.#isExpired(existing)) throw new CollectionGrantError('expired', 'The authorization expired while paused; re-authorize explicitly.');
        target = 'active'; break;
      case 'stop':
        if (existing.state === 'revoked') throw new CollectionGrantError('revoked', 'A revoked source cannot be stopped.');
        target = 'stopped'; reason = 'stopped'; break;
      case 'revoke':
        target = 'revoked'; reason = 'revoked'; break;
      default:
        throw new CollectionGrantError('invalid_request', 'Unknown transition action.');
    }

    const next = store.update({ grantId: existing.grantId, expectedRevision: existing.revision, state: target, revision: existing.revision + 1 });
    const grant = this.#toGrant(next);
    if (reason) this.#notify(grant, reason);
    return grant;
  }

  /**
   * Re-verify a grant immediately before capturing, before writing, and before projecting.
   * Returns the current revision on success and throws a typed reason otherwise.
   */
  assertActive(input: {
    readonly grantId: string;
    readonly grantRevision: number;
    readonly pairing: PairingScope;
    readonly kind: CollectionSourceKind;
  }): CollectionGrant {
    this.#open();
    const store = this.#store();
    const record = store.current(input.pairing, input.kind);
    if (!record || record.grantId !== input.grantId) throw new CollectionGrantError('not_found', 'The grant no longer exists for this source.');
    if (!this.#samePairing(record.pairing, input.pairing)) throw new CollectionGrantError('pairing_mismatch', 'The grant belongs to another pairing scope.');
    if (record.state === 'revoked') throw new CollectionGrantError('revoked', 'The source was revoked.');
    if (record.state === 'expired' || this.#isExpired(record)) throw new CollectionGrantError('expired', 'The authorization expired.');
    if (record.state === 'paused') throw new CollectionGrantError('forbidden', 'The source is paused.');
    if (record.state === 'stopped') throw new CollectionGrantError('forbidden', 'The source is stopped.');
    if (record.revision !== input.grantRevision) {
      // A late callback from a superseded revision must never be written.
      throw new CollectionGrantError('version_conflict', 'The grant revision advanced; this notification is stale.');
    }
    return this.#toGrant(record);
  }

  /**
   * Bind a source lease to the manager and the host resource registrar.
   * One live lease per kind: starting a second without closing the first is a caller bug.
   */
  async attachLease(binding: CollectionLeaseBinding, registrar?: HostReleaseRegistrar): Promise<void> {
    this.#open();
    if (this.leases.has(binding.kind)) {
      throw new CollectionGrantError('invalid_request', `A ${binding.kind} listener is already attached.`);
    }
    const resourceId = `collection:${binding.kind}:${binding.grantId}`;
    const release = async () => {
      this.leases.delete(binding.kind);
      await binding.release();
      if (registrar?.outstanding.includes(resourceId)) await registrar.release(resourceId);
    };
    this.leases.set(binding.kind, { ...binding, release });
    registrar?.register('listener', resourceId, release);
  }

  /** True when at least one lease is still attached for this kind. */
  hasLease(kind: CollectionSourceKind): boolean { return this.leases.has(kind); }

  /** Release one source lease without affecting other sources. */
  async releaseLease(kind: CollectionSourceKind): Promise<void> {
    const binding = this.leases.get(kind);
    if (!binding) return;
    this.leases.delete(kind);
    await binding.release();
  }

  /** Pause every active grant and stop its listener (lock/pack/session events). */
  async suspendAll(reason: CollectionRevokeReason, pairing?: PairingScope): Promise<void> {
    const store = this.options.store;
    // Invalidate authority first, including grants issued while the global mode was paused.
    // A callback racing with listener release must fail assertActive immediately.
    for (const scope of pairing ? [pairing] : this.knownPairings) {
      for (const kind of ['keyboard', 'screenshot_directory', 'clipboard_image'] as const) {
        const record = store?.current(scope, kind);
        if (record?.state !== 'active') continue;
        const next = store!.update({ grantId: record.grantId, expectedRevision: record.revision,
          state: 'paused', revision: record.revision + 1 });
        this.#notify(this.#toGrant(next), reason);
      }
    }
    for (const [kind, binding] of [...this.leases]) {
      this.leases.delete(kind);
      await binding.release();
    }
  }

  /** Release everything; idempotent, so a repeated shutdown is safe. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const pending = [...this.leases.values()].map(binding => Promise.resolve(binding.release()).catch(() => undefined));
    this.leases.clear();
    await Promise.all(pending);
    this.listeners.clear();
  }

  /** Pairings observed through issue/transition, used only for close-time bookkeeping. */
  private readonly knownPairings: PairingScope[] = [];

  #rememberPairing(pairing: PairingScope): void {
    if (!this.knownPairings.some(existing => this.#samePairing(existing, pairing))) this.knownPairings.push(pairing);
  }

  #store(): CollectionGrantStorePort {
    if (this.closed) throw new CollectionGrantError('store_unavailable', 'The grant manager is closed.');
    const store = this.options.store;
    if (!store) throw new CollectionGrantError('store_unavailable', 'No durable collection grant store is attached.');
    return store;
  }

  #open(): void {
    if (this.closed) throw new CollectionGrantError('store_unavailable', 'The grant manager is closed.');
  }

  #now(): string { return this.options.now?.() ?? new Date().toISOString(); }

  #isExpired(record: CollectionGrantRecord): boolean {
    const expires = Date.parse(record.expiresAt);
    const now = Date.parse(this.#now());
    if (Number.isNaN(expires) || Number.isNaN(now)) return true;
    return now >= expires;
  }

  #validatedExpiry(expiresAt: string, now: string): string {
    const parsed = Date.parse(expiresAt);
    const base = Date.parse(now);
    if (Number.isNaN(parsed)) throw new CollectionGrantError('invalid_request', 'expiresAt must be an ISO timestamp.');
    const max = base + this.options.policy.grantMaxDurationMs;
    if (parsed > max) {
      // The profile ceiling is a hard cap: a caller cannot mint a longer-lived grant than the policy allows.
      throw new CollectionGrantError('invalid_request', 'Requested expiry exceeds the profile maximum grant duration.');
    }
    if (parsed <= base) throw new CollectionGrantError('invalid_request', 'expiresAt must be in the future.');
    return new Date(parsed).toISOString();
  }

  #samePairing(left: PairingScope, right: PairingScope): boolean {
    return left.userId === right.userId && left.characterId === right.characterId
      && left.characterInstanceId === right.characterInstanceId;
  }

  #toGrant(record: CollectionGrantRecord): CollectionGrant {
    this.#rememberPairing(record.pairing);
    return Object.freeze({
      schemaVersion: 1,
      grantId: record.grantId,
      revision: record.revision,
      pairing: record.pairing,
      kind: record.kind,
      ...(record.directoryRoot ? { directoryRoot: record.directoryRoot } : {}),
      purpose: record.purpose,
      destination: record.destination,
      policyVersion: record.policyVersion,
      state: record.state,
      grantedAt: record.grantedAt,
      expiresAt: record.expiresAt,
    });
  }

  #notify(grant: CollectionGrant, reason: CollectionRevokeReason): void {
    for (const listener of this.listeners) {
      try { listener(grant, reason); } catch { /* a failing listener must not block release */ }
    }
  }
}
