import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { MemoryTurnInput, MemoryTurnOutcome, MemoryTurnPlan } from '../contracts/memory-lifecycle.js';
import type { TurnScope } from '../contracts/index.js';
import type { HistoricalMessage } from './import-source.js';
import { MemoryImportError } from './import-source.js';
import type { MemoryRecord } from './ledger.js';
import { SqliteLedgerBacking } from './sqlite-backing.js';
import type { SqliteMemoryStore } from './sqlite-store.js';
import { applySourcePlan } from './sqlite-source-plan.js';
import { MemoryRuleError, bindScope, sameScope, timestamp } from './scope.js';

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
};
const digest = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');
const recordId = (characterId: string, message: HistoricalMessage): string => `import:${digest([characterId, message.namespace, message.itemId]).slice(0, 48)}`;

export interface ImportedEvidenceResult {
  readonly recordId: string;
  readonly inserted: boolean;
  readonly role: HistoricalMessage['role'];
  readonly createdAt: string;
}
export interface ImportedCommitResult {
  readonly importedMemories: number;
  readonly affectedIds: readonly string[];
  readonly replayed: boolean;
}
interface ImportEvidenceRow {
  record_id: string;
  source_kind: 'codex-project' | 'text-export';
  source_namespace: string;
  source_item_id: string;
  source_at: string;
  speaker: HistoricalMessage['role'];
  content_hash: string;
}
interface ImportTicket {
  readonly fingerprint:string;
  readonly epoch:number;
  readonly pendingFingerprint:string;
}

/** Companion-store component for historical evidence. It does not own the job queue. */
export class SqliteImportedMemory {
  private readonly tickets=new WeakMap<MemoryTurnInput,ImportTicket>();
  constructor(private readonly db: Database.Database, private readonly store: SqliteMemoryStore) {
    db.exec(`CREATE TABLE IF NOT EXISTS memory_import_evidence(
      character_id TEXT NOT NULL,record_id TEXT NOT NULL,source_kind TEXT NOT NULL CHECK(source_kind IN ('codex-project','text-export')),
      source_namespace TEXT NOT NULL,source_item_id TEXT NOT NULL,project_name TEXT NOT NULL,source_at TEXT NOT NULL,
      speaker TEXT NOT NULL CHECK(speaker IN ('user','assistant')),content_hash TEXT NOT NULL,job_id TEXT NOT NULL,
      PRIMARY KEY(character_id,source_namespace,source_item_id),UNIQUE(character_id,record_id),
      FOREIGN KEY(character_id,record_id) REFERENCES memory_records(character_id,id));
      CREATE INDEX IF NOT EXISTS memory_import_evidence_record ON memory_import_evidence(character_id,record_id);
      CREATE TABLE IF NOT EXISTS memory_import_processed(
        character_id TEXT NOT NULL,record_id TEXT NOT NULL,PRIMARY KEY(character_id,record_id),
        FOREIGN KEY(character_id,record_id) REFERENCES memory_import_evidence(character_id,record_id));`);
  }

  isEvidence(scope: TurnScope, id: string): boolean {
    bindScope(scope, scope.characterId);
    return !!this.db.prepare('SELECT 1 FROM memory_import_evidence WHERE character_id=? AND record_id=?').get(scope.characterId, id);
  }

  addEvidence(scope: TurnScope, input: {
    readonly jobId: string;
    readonly sourceKind: 'codex-project' | 'text-export';
    readonly projectName: string;
    readonly messages: readonly HistoricalMessage[];
  }): readonly ImportedEvidenceResult[] {
    const owned = bindScope(scope, scope.characterId);
    if (owned.characterId !== 'companion' || !input.jobId || !input.projectName.trim()) throw new MemoryRuleError('invalid_import_identity');
    return this.db.transaction(() => {
      const backing = new SqliteLedgerBacking(this.db, owned.characterId);
      const pending = input.messages.filter(message => !this.db.prepare('SELECT 1 FROM memory_import_evidence WHERE character_id=? AND source_namespace=? AND source_item_id=?')
        .get(owned.characterId, message.namespace, message.itemId));
      const minimum = (this.db.prepare('SELECT min(logical_order) AS value FROM memory_records WHERE character_id=?').get(owned.characterId) as {value:number|null}).value ?? 0;
      let order = minimum - pending.length;
      const result: ImportedEvidenceResult[] = [];
      for (const message of input.messages) {
        timestamp(message.createdAt);
        if (!message.itemId.trim() || !message.namespace.trim() || !message.text.trim() || message.text.includes('\0')) throw new MemoryImportError('invalid_source_entry');
        const hash = digest([message.role, message.createdAt, message.text]);
        const prior = this.db.prepare('SELECT * FROM memory_import_evidence WHERE character_id=? AND source_namespace=? AND source_item_id=?')
          .get(owned.characterId, message.namespace, message.itemId) as ImportEvidenceRow | undefined;
        if (prior) {
          // Canonical message identity is format-independent. Keep the first source metadata,
          // while accepting the same immutable utterance from a later export representation.
          if (prior.content_hash !== hash || prior.speaker !== message.role || prior.source_at !== message.createdAt) throw new MemoryImportError('source_changed', prior.record_id);
          // A previous process may have committed evidence but lost its job checkpoint. A user
          // item is complete only after its durable turn outcome exists; reruns never repeat it.
          const completed=message.role==='assistant'||!!this.db.prepare(`SELECT 1 FROM memory_import_processed WHERE character_id=? AND record_id=?
            UNION ALL SELECT 1 FROM memory_turn_outcomes WHERE character_id=? AND current_message_id=? LIMIT 1`).get(owned.characterId,prior.record_id,owned.characterId,prior.record_id);
          result.push({ recordId: prior.record_id, inserted: !completed, role: message.role, createdAt: message.createdAt });
          continue;
        }
        const id = recordId(owned.characterId, message);
        if (backing.records.has(id)) throw new MemoryImportError('commit_conflict', id);
        const record: MemoryRecord = {
          origin: 'conversation', characterId: owned.characterId, id, kind: 'transcript', version: 1, state: 'active', text: message.text,
          sources: [], createdAt: message.createdAt, deletedAt: null,
          reason: message.role === 'assistant' ? 'historical_assistant_context' : 'historical_import_source',
          message: { origin: 'conversation', characterId: owned.characterId, id, role: message.role, text: message.text, createdAt: message.createdAt },
          perception: null, evidenceEligible: message.role === 'user', logicalOrder: order++, fragment: null,
        };
        backing.records.set(id, record);
        // Historical evidence has its own lifecycle and must never consume the ordinary raw-chat quota.
        this.db.prepare('UPDATE memory_records SET transcript_bytes=0 WHERE character_id=? AND id=?').run(owned.characterId, id);
        this.db.prepare('INSERT INTO memory_import_evidence VALUES(?,?,?,?,?,?,?,?,?,?)').run(
          owned.characterId, id, input.sourceKind, message.namespace, message.itemId, input.projectName,
          message.createdAt, message.role, hash, input.jobId,
        );
        result.push({ recordId: id, inserted: true, role: message.role, createdAt: message.createdAt });
      }
      if (result.some(item => item.inserted)) {
        backing.revision++; backing.epoch++;
        this.store.recall.invalidate();
      }
      return result;
    }).immediate();
  }

  private source(scope: TurnScope, record: MemoryRecord): MemoryTurnInput['sources'][number] {
    if (!['transcript', 'summary', 'memory'].includes(record.kind) || record.state !== 'active') throw new MemoryRuleError('invalid_import_source');
    return { ...(record.origin ? { origin: record.origin } : {}), scope, id: record.id, version: record.version,
      kind: record.kind as 'transcript' | 'summary' | 'memory', text: record.text, createdAt: record.createdAt,
      messageRole: record.message?.role ?? null, sourceVersions: record.sources.map(item => ({...item})), evidenceEligible: record.evidenceEligible !== false };
  }

  buildInput(scope: TurnScope, messageIds: readonly string[], currentMessageId: string, limits: {maxMemories:number;maxInputBytes:number}): MemoryTurnInput {
    const owned = bindScope(scope, scope.characterId);
    if (!messageIds.length || new Set(messageIds).size !== messageIds.length || !Number.isSafeInteger(limits.maxMemories) || limits.maxMemories < 0 || !Number.isSafeInteger(limits.maxInputBytes) || limits.maxInputBytes < 1) throw new MemoryRuleError('invalid_import_batch');
    return this.db.transaction(()=>{
      const pending=this.store.pending.contextBoundary(owned.characterId);
      if(pending.active)throw new MemoryRuleError('pending_memory_import_blocked');
      const records = messageIds.map(id => {
        const record = this.store.inspect(owned, id);
        if (!record || !this.isEvidence(owned, id) || record.kind !== 'transcript' || record.state !== 'active' || !record.message) throw new MemoryRuleError('import_source_unavailable');
        return record;
      }).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      const current = records.find(record => record.id === currentMessageId);
      if (!current || current.message?.role !== 'user' || current.evidenceEligible === false) throw new MemoryRuleError('invalid_import_current');
      const query = records.filter(record => record.message?.role === 'user').map(record => record.text).join(' ');
      const references = this.store.searchForMaintenance(owned, query, limits.maxMemories, 'lexical');
      const memories = references.map(reference => this.store.inspect(owned, reference.id)).filter((record): record is MemoryRecord => !!record && record.kind === 'memory' && record.state === 'active');
      const build = (selected: readonly MemoryRecord[]): MemoryTurnInput => ({
        scope: owned, currentMessageId,
        sources: [...records, ...selected].map(record => this.source(owned, record)),
        messages: records.map(record => record.message!),
        relevantMemories: selected.map(record => ({ ...(record.origin ? {origin:record.origin} : {}), characterId:owned.characterId,id:record.id,version:record.version,text:record.text,sourceIds:[...new Set(record.sources.map(source => source.id))] })),
      });
      for (let count = memories.length; count >= 0; count--) {
        const input = build(memories.slice(0, count));
        if (Buffer.byteLength(JSON.stringify(input), 'utf8') <= limits.maxInputBytes){
          const epoch=(this.db.prepare('SELECT epoch FROM characters WHERE character_id=?').get(owned.characterId) as {epoch:number}).epoch;
          this.tickets.set(input,{fingerprint:digest(input),epoch,pendingFingerprint:pending.fingerprint});return input;
        }
      }
      throw new MemoryImportError('invalid_source_entry', currentMessageId);
    })();
  }

  hasOutcome(scope: TurnScope, currentMessageId: string): boolean {
    bindScope(scope, scope.characterId);
    return !!this.db.prepare('SELECT 1 FROM memory_turn_outcomes WHERE character_id=? AND current_message_id=?').get(scope.characterId, currentMessageId);
  }

  outcome(scope: TurnScope, currentMessageId: string): ImportedCommitResult | null {
    bindScope(scope, scope.characterId);
    const row = this.db.prepare('SELECT scope_json,outcome_json FROM memory_turn_outcomes WHERE character_id=? AND current_message_id=?')
      .get(scope.characterId, currentMessageId) as {scope_json:string;outcome_json:string} | undefined;
    if (!row) return null;
    if (!sameScope(JSON.parse(row.scope_json), scope)) throw new MemoryRuleError('processed_turn_identity_mismatch');
    const outcome = JSON.parse(row.outcome_json) as MemoryTurnOutcome;
    return { importedMemories: outcome.results.filter(result => result.status === 'applied').length, affectedIds: outcome.affectedIds, replayed: true };
  }

  commit(scope: TurnScope, input: MemoryTurnInput, proposal: MemoryTurnPlan): ImportedCommitResult {
    const owned = bindScope(scope, scope.characterId), plan = structuredClone(proposal),ticket=this.tickets.get(input);
    this.tickets.delete(input);
    return this.db.transaction(() => {
      const prior = this.outcome(owned, input.currentMessageId);
      if (prior) return prior;
      const epoch=(this.db.prepare('SELECT epoch FROM characters WHERE character_id=?').get(owned.characterId) as {epoch:number}).epoch;
      const pending=this.store.pending.contextBoundary(owned.characterId);
      if(!ticket||ticket.fingerprint!==digest(input)||ticket.epoch!==epoch||pending.active||ticket.pendingFingerprint!==pending.fingerprint)throw new MemoryRuleError('stale_import_ticket');
      for(const source of input.sources){
        const actual=this.store.inspect(owned,source.id);
        if(!sameScope(source.scope,owned)||!actual||actual.state!=='active'||actual.version!==source.version||digest(this.source(owned,actual))!==digest(source))throw new MemoryRuleError('stale_import_source');
      }
      if (!sameScope(plan.scope, owned) || plan.request !== 'none' || plan.clarification !== null || plan.suppressSources.length || (plan.retainSources?.length ?? 0)) throw new MemoryRuleError('unsafe_import_plan');
      if (plan.dynamics?.reinforcements.length) throw new MemoryRuleError('historical_reinforcement_forbidden');
      const known = new Map(input.sources.map(source => [source.id, source]));
      const imported = new Set(input.sources.filter(source => source.kind === 'transcript' && source.messageRole === 'user' && source.evidenceEligible !== false && this.isEvidence(owned, source.id)).map(source => source.id));
      const added = new Set<string>();
      const changes = plan.changes.map(change => {
        if (!sameScope(change.scope, owned) || change.operation.type !== 'add') throw new MemoryRuleError('historical_plan_add_only');
        const op = change.operation;
        if (!op.sourceIds.some(id => imported.has(id)) || op.sourceIds.some(id => !known.get(id)?.evidenceEligible)) throw new MemoryRuleError('historical_fact_requires_user_source');
        if (added.has(op.id)) throw new MemoryRuleError('duplicate_import_memory');
        const sourceDates = op.sourceIds.map(id => known.get(id)).filter(source => source && imported.has(source.id)).map(source => source!.createdAt).sort();
        const createdAt=sourceDates.at(-1)!,text=`[历史对话 ${createdAt.slice(0,10)}] ${op.text}`;
        const duplicate = this.db.prepare("SELECT 1 FROM memory_records WHERE character_id=? AND kind='memory' AND state='active' AND text=?").get(owned.characterId, text);
        if (duplicate) throw new MemoryRuleError('duplicate_memory_text');
        added.add(op.id);
        return { ...change, createdAt, operation:{...op,text} };
      });
      const normalized: MemoryTurnPlan = { ...plan, changes };
      const {results,affectedIds} = applySourcePlan(this.db, this.store, input, normalized, {prune:false});
      for (const [index, trait] of (normalized.dynamics?.traits ?? []).entries()) {
        if (!added.has(trait.recordId) || trait.expectedVersion !== 1) throw new MemoryRuleError('invalid_import_dynamics_target');
        this.store.dynamics.applyTraits(owned, { ...trait, operationId:`import-dynamics:${input.currentMessageId}:${index}` });
      }
      this.store.recall.invalidate();
      const outcome: MemoryTurnOutcome = { scope:owned, request:'none', status:affectedIds.length ? 'applied' : 'unchanged', results, affectedIds,
        retrievalInvalidated:affectedIds.length > 0, clarification:null, rejectionCode:null };
      this.db.prepare('INSERT INTO memory_turn_outcomes(character_id,current_message_id,scope_json,text_hash,plan_hash,outcome_json) VALUES(?,?,?,?,?,?)')
        .run(owned.characterId, input.currentMessageId, JSON.stringify(owned), digest(input.sources.map(source => [source.id,source.version,source.text])), digest(normalized), JSON.stringify(outcome));
      const mark=this.db.prepare('INSERT OR IGNORE INTO memory_import_processed(character_id,record_id) VALUES(?,?)');
      for(const id of imported)mark.run(owned.characterId,id);
      return { importedMemories:changes.length, affectedIds, replayed:false };
    }).immediate();
  }
}
