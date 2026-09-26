/**
 * management/collection-management.ts
 *
 * N081-06: binds the 0.81 collection service/store to the management API port.
 *
 * The console never touches SQLite or the native helper: it goes through these methods, which fix
 * the pairing from the running instance and translate service refusals into stable error codes.
 * Idempotency is enforced here as well as in the store, so a repeated `operationId` returns the
 * first result instead of repeating a side effect.
 */

import type { PairingScope } from '../contracts/character-pack.js';
import type { CollectionSourceKind, CollectionStatus } from '../contracts/collection.js';
import type { CollectionGrantManager } from '../core/collection-grants.js';
import type { CollectionService } from '../core/collection-service.js';
import type { CollectionStore } from '../memory/collection-store.js';
import type { CollectionManagementPort } from './collection-routes.js';

export interface CollectionManagementOptions {
  readonly service: CollectionService;
  readonly grants: CollectionGrantManager;
  readonly store: CollectionStore;
  readonly pairing: PairingScope;
  readonly now?: () => string;
  /** Starts or stops the OS listener for one source after a state change. */
  readonly syncSource?: (kind: CollectionSourceKind, active: boolean) => Promise<void>;
}

interface OperationRecord { readonly signature: string; readonly result: unknown }

export class CollectionManagement implements CollectionManagementPort {
  /** operationId -> first result, so a replay returns the initial outcome rather than re-acting. */
  private readonly operations = new Map<string, OperationRecord>();

  constructor(private readonly options: CollectionManagementOptions) {}

  status(): Promise<CollectionStatus> {
    return Promise.resolve(this.options.service.status());
  }

  async activate(input: {
    readonly kind: CollectionSourceKind; readonly directoryRoot?: string; readonly expiresAt: string;
    readonly expectedRevision: number; readonly operationId: string;
  }): Promise<CollectionStatus> {
    return this.#idempotent(input.operationId, ['activate', input.kind, input.directoryRoot ?? '', input.expiresAt,
      String(input.expectedRevision)], async () => {
      this.options.grants.issue({
        pairing: this.options.pairing, kind: input.kind,
        ...(input.directoryRoot !== undefined ? { directoryRoot: input.directoryRoot } : {}),
        expiresAt: input.expiresAt,
        expectedRevision: input.expectedRevision,
        operationId: input.operationId,
      });
      // Only after the grant is durable does the listener start.
      await this.options.syncSource?.(input.kind, true);
      return this.options.service.status();
    });
  }

  async transition(input: {
    readonly kind: CollectionSourceKind;
    readonly action: 'pause' | 'resume' | 'stop' | 'revoke';
    readonly expectedRevision: number; readonly operationId: string;
  }): Promise<CollectionStatus> {
    return this.#idempotent(input.operationId, ['transition', input.kind, input.action, String(input.expectedRevision)],
      async () => {
        const grant = this.options.grants.transition({
          pairing: this.options.pairing, kind: input.kind, action: input.action,
          expectedRevision: input.expectedRevision, operationId: input.operationId,
        });
        // P1-2: A paused/stopped/revoked source must stop listening; a resumed (active) source must restart listening.
        if (grant.state === 'active') {
          await this.options.syncSource?.(input.kind, true);
        } else {
          await this.options.syncSource?.(input.kind, false);
        }
        if (input.action === 'revoke') {
          // Revocation removes this source's evidence, so its samples and managed copies go too.
          this.options.store.erase({
            pairing: this.options.pairing, scope: 'source', sourceKind: input.kind,
            expectedRevision: this.options.store.revision, operationId: `${input.operationId}:erase`,
          });
        }
        return this.options.service.status();
      });
  }

  async list(query: {
    readonly from: string; readonly to: string; readonly kinds?: readonly CollectionSourceKind[];
    readonly limit: number; readonly cursor?: string;
  }): Promise<unknown> {
    return this.options.store.list({
      pairing: this.options.pairing, from: query.from, to: query.to,
      ...(query.kinds ? { kinds: query.kinds } : {}), limit: query.limit,
      ...(query.cursor ? { cursor: query.cursor } : {}),
    });
  }

  async readAsset(input: { readonly sampleId: string; readonly variant: 'thumbnail' | 'original' }) {
    // The store re-checks pairing, validity and expiry on every read.
    return this.options.store.readAsset(this.options.pairing, input.sampleId, input.variant);
  }

  async feedback(input: {
    readonly sampleId: string; readonly label: 'useful' | 'not_useful' | 'mismatch';
    readonly expectedRevision: number; readonly operationId: string;
  }): Promise<{ readonly revision: number }> {
    return this.#idempotent(input.operationId, ['feedback', input.sampleId, input.label, String(input.expectedRevision)],
      async () => this.options.store.feedback({
        pairing: this.options.pairing, sampleId: input.sampleId, label: input.label,
        expectedRevision: input.expectedRevision, operationId: input.operationId,
      }));
  }

  async recordMissing(input: {
    readonly kind: CollectionSourceKind; readonly observedAt: string; readonly operationId: string;
  }): Promise<{ readonly id: string }> {
    // A miss annotates the trial; it never creates a sample or a Timeline card.
    return this.#idempotent(input.operationId, ['missing', input.kind, input.observedAt],
      async () => this.options.store.recordMissing(this.options.pairing, input.kind, input.observedAt, input.operationId));
  }

  async erase(input: {
    readonly scope: 'item' | 'range' | 'all';
    readonly sampleId?: string; readonly from?: string; readonly to?: string;
    readonly expectedRevision: number; readonly operationId: string;
  }): Promise<{ readonly affected: number; readonly revision: number }> {
    return this.#idempotent(input.operationId,
      ['erase', input.scope, input.sampleId ?? '', input.from ?? '', input.to ?? '', String(input.expectedRevision)],
      async () => this.options.store.erase({
        pairing: this.options.pairing, scope: input.scope,
        ...(input.sampleId !== undefined ? { sampleId: input.sampleId } : {}),
        ...(input.from !== undefined ? { from: input.from } : {}),
        ...(input.to !== undefined ? { to: input.to } : {}),
        expectedRevision: input.expectedRevision, operationId: input.operationId,
      }));
  }

  /**
   * Run one write at most once. A replay with the same body returns the first result; a replay with
   * a different body is a conflict, because the caller is reusing an id for different intent.
   */
  async #idempotent<T>(id: string, signatureParts: readonly string[], act: () => Promise<T>): Promise<T> {
    const signature = signatureParts.join('\u0000');
    const existing = this.operations.get(id);
    if (existing) {
      if (existing.signature !== signature) throw new Error('invalid_request');
      return existing.result as T;
    }
    const result = await act();
    this.operations.set(id, { signature, result });
    // Bound the replay table; the store's own tombstones carry the durable guarantee.
    if (this.operations.size > 512) {
      const oldest = this.operations.keys().next();
      if (!oldest.done) this.operations.delete(oldest.value);
    }
    return result;
  }
}
