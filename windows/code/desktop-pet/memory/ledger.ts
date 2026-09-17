import type {
  CharacterId, ConversationMessage, MemoryChange, MemoryChangeResult,
  MemoryMaintenanceInput, MemoryReference, PerceptionResult, TurnScope,
} from '../contracts/index.js';
import { memoryBacking, type LedgerBacking } from './backing.js';
import { MemoryRuleError, assertCharacter, bindScope, sameScope, timestamp } from './scope.js';

export type DerivedKind = 'summary' | 'keyword_index' | 'vector_index' | 'context_cache';
export type RecordKind = 'transcript' | 'memory' | 'emotion' | DerivedKind;
export interface SourceVersion { readonly id: string; readonly version: number }
export interface MemoryRecord {
  readonly origin?: 'conversation' | 'automatic' | 'manual';
  readonly characterId: CharacterId;
  readonly id: string;
  readonly kind: RecordKind;
  readonly version: number;
  readonly state: 'active' | 'invalidated' | 'deleted' | 'expired' | 'purged';
  readonly text: string;
  readonly sources: readonly SourceVersion[];
  readonly createdAt: string;
  readonly deletedAt: string | null;
  readonly reason: string | null;
  readonly message: ConversationMessage | null;
  readonly perception: PerceptionResult | null;
  readonly evidenceEligible?: boolean;
  readonly logicalOrder?: number;
  readonly fragment?: { parent: SourceVersion; start: number; end: number } | null;
}
export interface MaintenanceTask {
  readonly scope: TurnScope;
  readonly input: MemoryMaintenanceInput;
}
export interface ContextRecords {
  readonly characterId: CharacterId;
  readonly revision: number;
  readonly recent: readonly ConversationMessage[];
  readonly summaries: readonly MemoryRecord[];
  readonly memories: readonly MemoryReference[];
}

const DELETED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // R16; unrelated to D06 transcript quota.
const clone = <T>(value: T): T => structuredClone(value);

/** Role rules. The default backing is process-local; a persistent caller must wrap mutations in a transaction. */
export class RoleMemoryLedger {
  readonly #characterId: CharacterId;
  readonly #backing: LedgerBacking;
  get #records() { return this.#backing.records; }
  get #revision() { return this.#backing.revision; }
  set #revision(value: number) { this.#backing.revision = value; }
  get #maintenanceEpoch() { return this.#backing.epoch; }
  set #maintenanceEpoch(value: number) { this.#backing.epoch = value; }
  get #operations() { return this.#backing.operations; }
  #tasks = new WeakMap<MaintenanceTask, { scope: TurnScope; epoch: number; sources: Set<string> }>();

  constructor(characterId: CharacterId, backing: LedgerBacking = memoryBacking(characterId)) {
    assertCharacter(characterId);
    if (backing.characterId !== characterId) throw new MemoryRuleError('character_mismatch');
    this.#characterId = characterId;
    this.#backing = backing;
  }

  get characterId(): CharacterId { return this.#characterId; }

  append(scope: TurnScope, messages: readonly ConversationMessage[]): void {
    bindScope(scope, this.#characterId);
    const batchIds = new Set<string>();
    for (const message of messages) {
      if (message.characterId !== this.#characterId) throw new MemoryRuleError('character_mismatch');
      if (message.role !== 'user' && message.role !== 'assistant') throw new MemoryRuleError('invalid_message_role');
      if (message.origin === 'manual') throw new MemoryRuleError('manual_origin_requires_management');
      timestamp(message.createdAt);
      this.#assertNewId(message.id);
      if (batchIds.has(message.id)) throw new MemoryRuleError('duplicate_id');
      batchIds.add(message.id);
    }
    for (const message of messages) {
      this.#records.set(message.id, this.#record(message.id, 'transcript', message.text, [], message.createdAt, { ...(message.origin?{origin:message.origin}:{}),message: clone(message) }));
    }
    if (messages.length) this.#advanceRevision();
  }

  recordPerception(scope: TurnScope, id: string, perception: PerceptionResult, createdAt: string, sourceIds: readonly string[]): void {
    const owned = bindScope(scope, this.#characterId);
    if (!sameScope(owned, perception.scope)) throw new MemoryRuleError('perception_scope_mismatch');
    this.#assertNewId(id);
    timestamp(createdAt);
    for (const cue of perception.cues) timestamp(cue.expiresAt);
    const sources = this.#sources(sourceIds);
    // Keep cues and modality evidence; never duplicate the raw transcript in emotion history.
    this.#records.set(id, this.#record(id, 'emotion', '', sources, createdAt, { perception: clone({ ...perception, transcript: '' }) }));
    this.#advanceRevision();
  }

  recordDerived(scope: TurnScope, entry: { id: string; kind: DerivedKind; text: string; sourceIds: readonly string[]; createdAt: string }): void {
    bindScope(scope, this.#characterId);
    if (!['summary', 'keyword_index', 'vector_index', 'context_cache'].includes(entry.kind)) throw new MemoryRuleError('invalid_derived_kind');
    this.#assertNewId(entry.id);
    const sources = this.#sources(entry.sourceIds);
    timestamp(entry.createdAt);
    this.#records.set(entry.id, this.#record(entry.id, entry.kind, entry.text, sources, entry.createdAt));
    this.#advanceRevision(entry.kind === 'context_cache' ? entry.id : undefined);
  }

  captureMaintenance(scope: TurnScope): MaintenanceTask {
    const owned = bindScope(scope, this.#characterId);
    const data = this.contextRecords(owned);
    const input: MemoryMaintenanceInput = clone({ scope: owned, messages: data.recent, relevantMemories: data.memories });
    const task = Object.freeze({ scope: owned, input });
    this.#tasks.set(task, { scope: owned, epoch: this.#maintenanceEpoch, sources: new Set([...data.recent, ...data.memories].map(item => item.id)) });
    return task;
  }

  /** Caller may await a model elsewhere. All results are checked against the task's original role and epoch. */
  completeMaintenance(task: MaintenanceTask, changes: readonly MemoryChange[], now: string): readonly MemoryChangeResult[] {
    const ticket = this.#tasks.get(task);
    const reject = (reason: string) => changes.map(change => this.#result(change, 'rejected', [], false, reason));
    if (!ticket) return reject('unknown_or_consumed_task');
    this.#tasks.delete(task);
    if (ticket.epoch !== this.#maintenanceEpoch) return reject('stale_maintenance_epoch');
    if (changes.some(change => !sameScope(change.scope, ticket.scope))) return reject('task_scope_mismatch');
    for (const change of changes) {
      const op = change.operation;
      const sourceIds = op.type === 'add' || op.type === 'update' ? op.sourceIds : op.type === 'merge' ? op.replacement.sourceIds : [];
      if (sourceIds.some(id => !ticket.sources.has(id))) return reject('source_not_in_task_input');
    }
    // No await between validation and application: mutations cannot interleave inside this process-local batch.
    return changes.map(change => this.apply(change, now));
  }

  apply(change: MemoryChange, now: string): MemoryChangeResult {
    try {
      bindScope(change.scope, this.#characterId);
      timestamp(now);
      timestamp(change.createdAt);
      if (!change.operationId || !change.reason.trim()) throw new MemoryRuleError('missing_operation_metadata');
      // Reused IDs never write again, even after a deletion/purge. Caller can inspect the original result externally.
      if (this.#operations.has(change.operationId)) throw new MemoryRuleError('operation_id_already_used');
      const op = change.operation;
      const affected = new Set<string>();
      if (op.type === 'add') {
        this.#assertNewId(op.id);
        const sources = this.#sources(op.sourceIds);
        this.#records.set(op.id, this.#record(op.id, 'memory', op.text, sources, change.createdAt));
        affected.add(op.id);
      } else if (op.type === 'update') {
        const old = this.#target(op.id, op.expectedVersion, 'active');
        const sources = this.#sources(op.sourceIds);
        // A direct self-reference names the prior version, not the new value. Derived descendants are not independent evidence.
        if (this.#descendants([op.id]).some(id => op.sourceIds.includes(id))) throw new MemoryRuleError('cyclic_source');
        for (const id of this.#invalidate([old.id], new Set([old.id]), change.reason, now)) affected.add(id);
        this.#records.set(old.id, { ...old, ...(old.origin?{origin:'automatic' as const}:{}), version: old.version + 1, text: op.text, sources, reason: change.reason });
        affected.add(old.id);
        this.#maintenanceEpoch++;
      } else if (op.type === 'merge') {
        if (op.targets.length < 2 || new Set(op.targets.map(target => target.id)).size !== op.targets.length) throw new MemoryRuleError('invalid_merge_targets');
        const targets = op.targets.map(target => this.#target(target.id, target.expectedVersion, 'active'));
        this.#assertNewId(op.replacement.id);
        const sources = this.#sources(op.replacement.sourceIds);
        // Sources are validated before retiring targets: their versioned provenance remains after payload expiry.
        for (const id of this.#invalidate(targets.map(target => target.id), new Set(), change.reason, now)) affected.add(id);
        for (const target of targets) {
          this.#records.set(target.id, { ...target, state: 'deleted', version: target.version + 1, deletedAt: now, reason: change.reason });
          affected.add(target.id);
        }
        this.#records.set(op.replacement.id, this.#record(op.replacement.id, 'memory', op.replacement.text, sources, change.createdAt));
        affected.add(op.replacement.id);
        this.#maintenanceEpoch++;
      } else if (op.type === 'soft_delete') {
        const old = this.#target(op.id, op.expectedVersion, 'active');
        for (const id of this.#invalidate([old.id], new Set([old.id]), change.reason, now)) affected.add(id);
        this.#records.set(old.id, { ...old, state: 'deleted', version: old.version + 1, deletedAt: now, reason: change.reason });
        affected.add(old.id);
        this.#maintenanceEpoch++;
      } else if (op.type === 'restore') {
        const old = this.#target(op.id, op.expectedVersion, 'deleted');
        const elapsed = timestamp(now) - timestamp(old.deletedAt!);
        if (elapsed < 0 || elapsed >= DELETED_RETENTION_MS) throw new MemoryRuleError('restore_window_closed');
        this.#records.set(old.id, { ...old, state: 'active', version: old.version + 1, deletedAt: null, reason: change.reason });
        affected.add(old.id);
        this.#maintenanceEpoch++;
      } else {
        throw new MemoryRuleError('unknown_operation');
      }
      this.#operations.add(change.operationId);
      for (const id of this.#advanceRevision()) affected.add(id);
      return this.#result(change, 'applied', [...affected], true);
    } catch (error) {
      if (!(error instanceof MemoryRuleError)) throw error;
      const reason = error instanceof Error ? error.message : 'invalid_change';
      return this.#result(change, reason === 'version_conflict' ? 'conflict' : 'rejected', [], false, reason);
    }
  }

  /** Apply a resolved correction/forget request before acknowledging it. Source matching is not an NLP claim. */
  applyResolvedChange(change: MemoryChange, suppressSourceIds: readonly string[], now: string): MemoryChangeResult {
    try {
      bindScope(change.scope, this.#characterId);
      const op = change.operation;
      if (op.type !== 'update' && op.type !== 'soft_delete') throw new MemoryRuleError('resolution_requires_update_or_delete');
      const target = this.#target(op.id, op.expectedVersion, 'active');
      const ancestors = new Set<string>();
      const visit = (id: string): void => {
        if (ancestors.has(id)) return;
        ancestors.add(id);
        for (const source of this.#records.get(id)?.sources ?? []) visit(source.id);
      };
      for (const source of target.sources) visit(source.id);
      if (suppressSourceIds.some(id => !ancestors.has(id))) throw new MemoryRuleError('suppression_not_in_target_lineage');
      const suppressed = new Set([...suppressSourceIds, ...this.#descendants(suppressSourceIds)]);
      if (op.type === 'update' && op.sourceIds.some(id => suppressed.has(id))) throw new MemoryRuleError('new_evidence_will_be_suppressed');
      const result = this.apply(change, now);
      if (result.status !== 'applied') return result;
      // Preserve the corrected target, but never preserve its old derived copies.
      const extra = this.#invalidate(suppressSourceIds, new Set([target.id]), change.reason, now);
      if (extra.length) { this.#maintenanceEpoch++; this.#advanceRevision(); }
      return { ...result, affectedIds: [...new Set([...result.affectedIds, ...extra])] };
    } catch (error) {
      if (!(error instanceof MemoryRuleError)) throw error;
      const reason = error instanceof Error ? error.message : 'invalid_resolution';
      return this.#result(change, reason === 'version_conflict' ? 'conflict' : 'rejected', [], false, reason);
    }
  }

  /** Complete replacement supplied by a management user, distinct from automatic inference. */
  editManually(scope:TurnScope,input:{id:string;expectedVersion:number;text:string;reason:string},now:string):readonly string[] {
    bindScope(scope,this.#characterId); timestamp(now);
    const old=this.#records.get(input.id);
    if(!old)throw new MemoryRuleError('management_record_not_found');
    if(old.version!==input.expectedVersion)throw new MemoryRuleError('version_conflict');
    if(old.state!=='active'||!['memory','transcript','summary'].includes(old.kind))throw new MemoryRuleError('management_record_not_editable');
    // The user supplies a complete replacement. Old dependencies are audit metadata, never
    // evidence for these new bytes. Descendants still refer to the superseded version.
    const invalidated=this.#invalidate([old.id],new Set([old.id]),input.reason,now);
    this.#records.set(old.id,{...old,origin:'manual',version:old.version+1,text:input.text,sources:[],fragment:null,reason:input.reason,
      message:old.message?{...old.message,text:input.text,origin:'manual'}:null,evidenceEligible:true});
    this.#maintenanceEpoch++;
    return [...new Set([...invalidated,...this.#advanceRevision()])];
  }

  /** Explicit resolved source IDs: natural-language target resolution belongs to the later maintenance adapter. */
  suppressSources(scope: TurnScope, sourceIds: readonly string[], reason: string, now: string): readonly string[] {
    bindScope(scope, this.#characterId);
    timestamp(now);
    if (!reason.trim()) throw new MemoryRuleError('missing_reason');
    for (const id of sourceIds) if (!this.#records.has(id)) throw new MemoryRuleError('unknown_source');
    const affected = this.#invalidate(sourceIds, new Set(), reason, now);
    if (affected.length) { this.#maintenanceEpoch++; this.#advanceRevision(); }
    return affected;
  }

  /** Retention adapter must resolve IDs using the approved D06 policy. Expiry itself never cascades to memories. */
  expireTranscripts(scope: TurnScope, ids: readonly string[]): void {
    bindScope(scope, this.#characterId);
    const records = ids.map(id => {
      const record = this.#records.get(id);
      if (!record || record.kind !== 'transcript') throw new MemoryRuleError('unknown_transcript');
      return record;
    });
    for (const record of records) this.#records.set(record.id, { ...record, state: 'expired', text: '', message: null, reason: 'transcript_expired' });
    if (records.length) { this.#maintenanceEpoch++; this.#advanceRevision(); }
  }

  purgeDeleted(scope: TurnScope, now: string): readonly string[] {
    bindScope(scope, this.#characterId);
    const at = timestamp(now);
    const purged: string[] = [];
    for (const record of this.#records.select(undefined, 'deleted')) {
      if (record.state !== 'deleted' || at - timestamp(record.deletedAt!) < DELETED_RETENTION_MS) continue;
      // Minimal identity/version tombstone prevents ID reuse; payload and provenance are removed.
      this.#records.set(record.id, { ...record, state: 'purged', text: '', sources: [], message: null, perception: null, reason: 'retention_elapsed' });
      purged.push(record.id);
    }
    if (purged.length) { this.#maintenanceEpoch++; this.#advanceRevision(); }
    return purged;
  }

  visible(scope: TurnScope, kind: RecordKind): readonly MemoryRecord[] {
    bindScope(scope, this.#characterId);
    return clone(this.#records.select(kind, 'active'));
  }

  inspect(scope: TurnScope, id: string): MemoryRecord | null {
    bindScope(scope, this.#characterId);
    return clone(this.#records.get(id) ?? null);
  }

  contextRecords(scope: TurnScope): ContextRecords {
    bindScope(scope, this.#characterId);
    return {
      characterId: this.#characterId, revision: this.#revision,
      recent: this.visible(scope, 'transcript').map(record => record.message!).sort((a, b) => timestamp(a.createdAt) - timestamp(b.createdAt)),
      summaries: this.visible(scope, 'summary'),
      memories: this.visible(scope, 'memory').map(record => ({ ...(record.origin?{origin:record.origin}:{}),characterId: this.#characterId, id: record.id, version: record.version, text: record.text, sourceIds: [...new Set(record.sources.map(source => source.id))] })),
    };
  }

  assertContextCurrent(scope: TurnScope, revision: number): void {
    bindScope(scope, this.#characterId);
    if (revision !== this.#revision) throw new MemoryRuleError('stale_context');
  }

  #advanceRevision(keepCacheId?: string): readonly string[] {
    const invalidated: string[] = [];
    // Invalidate negative query results too: a newly added fact has no prior dependency edge.
    for (const record of this.#records.select('context_cache', 'active')) {
      if (record.kind !== 'context_cache' || record.state !== 'active' || record.id === keepCacheId) continue;
      this.#records.set(record.id, { ...record, state: 'invalidated', text: '', version: record.version + 1, reason: 'context_revision_changed' });
      invalidated.push(record.id);
    }
    this.#revision++;
    return invalidated;
  }

  #assertNewId(id: string): void {
    if (!id || this.#records.has(id)) throw new MemoryRuleError('duplicate_or_empty_id');
  }

  #sources(ids: readonly string[]): SourceVersion[] {
    if (!ids.length || new Set(ids).size !== ids.length) throw new MemoryRuleError('missing_or_duplicate_sources');
    const provenance = new Map<string, SourceVersion>();
    const include = (ref: SourceVersion) => {
      if ((provenance.get(ref.id)?.version ?? 0) < ref.version) provenance.set(ref.id, { ...ref });
    };
    for (const id of ids) {
      const source = this.#records.get(id);
      if (!source || source.state !== 'active') throw new MemoryRuleError('source_not_retrievable');
      // Inherited IDs are provenance, not permission to read expired/deleted payloads.
      // Flatten metadata so later purging an intermediate source cannot break invalidation paths.
      for (const ref of source.sources) include(ref);
      include({ id, version: source.version });
    }
    return [...provenance.values()];
  }

  #target(id: string, version: number, state: MemoryRecord['state']): MemoryRecord {
    const record = this.#records.get(id);
    if (!record || record.kind !== 'memory') throw new MemoryRuleError('unknown_memory');
    if (record.version !== version) throw new MemoryRuleError('version_conflict');
    if (record.state !== state) throw new MemoryRuleError('invalid_memory_state');
    return record;
  }

  #record(id: string, kind: RecordKind, text: string, sources: readonly SourceVersion[], createdAt: string, extra: Partial<MemoryRecord> = {}): MemoryRecord {
    return { characterId: this.#characterId, id, kind, version: 1, state: 'active', text, sources, createdAt, deletedAt: null, reason: null, message: null, perception: null, ...extra };
  }

  #descendants(roots: readonly string[]): string[] {
    const visited = new Set(roots);
    const descendants: string[] = [];
    for (let changed = true; changed;) {
      changed = false;
      for (const record of this.#records.lineage()) {
        if (visited.has(record.id) || !record.sources.some(source => visited.has(source.id))) continue;
        visited.add(record.id); descendants.push(record.id); changed = true;
      }
    }
    return descendants;
  }

  #invalidate(roots: readonly string[], except: Set<string>, reason: string, now: string): string[] {
    const affected: string[] = [];
    for (const id of [...roots, ...this.#descendants(roots)]) {
      const record = this.#records.get(id);
      if (!record || record.state !== 'active' || except.has(id)) continue;
      if (record.kind === 'memory') {
        this.#records.set(id, { ...record, state: 'deleted', version: record.version + 1, deletedAt: now, reason });
      } else if (record.kind === 'transcript') {
        // Hidden immediately; the transcript retention adapter owns eventual raw payload cleanup.
        this.#records.set(id, { ...record, state: 'invalidated', version: record.version + 1, reason });
      } else {
        this.#records.set(id, { ...record, state: 'invalidated', version: record.version + 1, text: '', perception: null, reason: 'source_invalidated' });
      }
      affected.push(id);
    }
    return affected;
  }

  #result(change: MemoryChange, status: MemoryChangeResult['status'], affectedIds: readonly string[], retrievalInvalidated: boolean, reason?: string): MemoryChangeResult {
    return { characterId: this.#characterId, operationId: change.operationId, status, affectedIds, retrievalInvalidated, ...(reason ? { reason } : {}) };
  }
}
