// N07-04: User Soul, User Wiki and relationship overlay storage.
// This is an additive projection in the existing companion SQLite database. It never mutates the
// immutable Character Pack and every pair has its own revision/epoch for stale background rejection.
import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  ContinuityCorrectionInput,
  ContinuityDerivedCommit,
  ContinuityFact,
  ContinuityForgetInput,
  ContinuityLease,
  ContinuityMemoryPort,
  ContinuityMemorySnapshot,
  ContinuityMutationResult,
  ContinuityRecordInput,
} from '../contracts/continuity-memory.js';
import type { PairingScope } from '../contracts/character-pack.js';

interface StateRow { revision: number; epoch: number }
interface FactRow {
  id: string; user_id: string; character_id: string; instance_id: string;
  layer: ContinuityFact['layer']; kind: ContinuityFact['kind']; status: ContinuityFact['status'];
  text: string; source_ids_json: string; origin: ContinuityFact['origin']; evidence_eligible: number;
  created_at: string; updated_at: string; valid_from: string | null; valid_to: string | null;
  supersedes_id: string | null; version: number; revision: number;
}
interface OperationRow { signature: string; result_json: string | null }

export class ContinuityMemoryError extends Error {
  constructor(readonly code: 'invalid_request' | 'not_found' | 'version_conflict' | 'forbidden', message: string) {
    super(message); this.name = 'ContinuityMemoryError';
  }
}

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
};
const signature = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');

function pairKey(pairing: PairingScope): string { return `${pairing.userId}\u0000${pairing.characterId}\u0000${pairing.characterInstanceId}`; }
function assertPairing(pairing: PairingScope): void {
  for (const value of [pairing.userId, pairing.characterId, pairing.characterInstanceId]) {
    if (typeof value !== 'string' || !value.trim() || value.length > 128 || value.includes('\0')) throw new ContinuityMemoryError('invalid_request', '连续性配对标识无效。');
  }
}
function assertText(text: string, field = 'text'): void {
  if (typeof text !== 'string' || !text.trim() || text.length > 16_000 || text.includes('\0')) throw new ContinuityMemoryError('invalid_request', `${field} 无效。`);
}
function assertOperation(operationId: string): void { if (typeof operationId !== 'string' || !/^[A-Za-z0-9:_-]{1,160}$/.test(operationId)) throw new ContinuityMemoryError('invalid_request', 'operationId 无效。'); }
function isTime(value: string | undefined): boolean { return value === undefined || (typeof value === 'string' && Number.isFinite(Date.parse(value))); }

export class SqliteContinuityMemoryStore implements ContinuityMemoryPort {
  private constructor(private readonly db: Database.Database) {}

  static async open(target: Database.Database | { rawDatabaseForKnowledge(): Database.Database }): Promise<SqliteContinuityMemoryStore> {
    const db = 'rawDatabaseForKnowledge' in target ? target.rawDatabaseForKnowledge() : target;
    db.exec(`
      CREATE TABLE IF NOT EXISTS continuity_pair_state (
        user_id TEXT NOT NULL, character_id TEXT NOT NULL, instance_id TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0, epoch INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(user_id, character_id, instance_id)
      );
      CREATE TABLE IF NOT EXISTS continuity_facts (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL, character_id TEXT NOT NULL, instance_id TEXT NOT NULL,
        layer TEXT NOT NULL CHECK(layer IN ('user_soul','user_wiki','relationship')),
        kind TEXT NOT NULL CHECK(kind IN ('fact','inference','user_defined','state','milestone')),
        status TEXT NOT NULL CHECK(status IN ('candidate','active','superseded','revoked','expired')),
        text TEXT NOT NULL, source_ids_json TEXT NOT NULL,
        origin TEXT NOT NULL CHECK(origin IN ('user','manual','conversation','derived','assistant')),
        evidence_eligible INTEGER NOT NULL CHECK(evidence_eligible IN (0,1)),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        valid_from TEXT, valid_to TEXT, supersedes_id TEXT,
        version INTEGER NOT NULL CHECK(version > 0), revision INTEGER NOT NULL,
        FOREIGN KEY(user_id, character_id, instance_id) REFERENCES continuity_pair_state(user_id, character_id, instance_id)
      );
      CREATE INDEX IF NOT EXISTS continuity_facts_pair ON continuity_facts(user_id, character_id, instance_id, status, layer, updated_at);
      CREATE TABLE IF NOT EXISTS continuity_tombstones (
        user_id TEXT NOT NULL, character_id TEXT NOT NULL, instance_id TEXT NOT NULL,
        fact_id TEXT NOT NULL, reason TEXT NOT NULL, revoked_at TEXT NOT NULL,
        PRIMARY KEY(user_id, character_id, instance_id, fact_id)
      );
      CREATE TABLE IF NOT EXISTS continuity_operations (
        user_id TEXT NOT NULL, character_id TEXT NOT NULL, instance_id TEXT NOT NULL,
        operation_id TEXT NOT NULL, signature TEXT NOT NULL, result_json TEXT,
        PRIMARY KEY(user_id, character_id, instance_id, operation_id)
      );
    `);
    const hasHistory = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_records'").get());
    if (hasHistory) db.exec(`
      CREATE TRIGGER IF NOT EXISTS continuity_history_revoke_update
      AFTER UPDATE OF state, text, message_role ON memory_records
      WHEN OLD.state='active' AND (NEW.state<>'active' OR OLD.text IS NOT NEW.text OR OLD.message_role IS NOT NEW.message_role)
      BEGIN
        UPDATE continuity_pair_state SET revision=revision+1, epoch=epoch+1
        WHERE EXISTS (SELECT 1 FROM continuity_facts fact WHERE fact.user_id=continuity_pair_state.user_id AND fact.character_id=continuity_pair_state.character_id AND fact.instance_id=continuity_pair_state.instance_id AND fact.status<>'revoked' AND EXISTS (SELECT 1 FROM json_each(fact.source_ids_json) source WHERE source.value='history:' || OLD.id));
        UPDATE continuity_facts
        SET status='revoked', text='', version=version+1, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            revision=(SELECT revision FROM continuity_pair_state WHERE user_id=continuity_facts.user_id AND character_id=continuity_facts.character_id AND instance_id=continuity_facts.instance_id)
        WHERE status<>'revoked' AND EXISTS (SELECT 1 FROM json_each(source_ids_json) source WHERE source.value='history:' || OLD.id);
      END;
      CREATE TRIGGER IF NOT EXISTS continuity_history_revoke_delete
      AFTER DELETE ON memory_records
      WHEN OLD.state='active'
      BEGIN
        UPDATE continuity_pair_state SET revision=revision+1, epoch=epoch+1
        WHERE EXISTS (SELECT 1 FROM continuity_facts fact WHERE fact.user_id=continuity_pair_state.user_id AND fact.character_id=continuity_pair_state.character_id AND fact.instance_id=continuity_pair_state.instance_id AND fact.status<>'revoked' AND EXISTS (SELECT 1 FROM json_each(fact.source_ids_json) source WHERE source.value='history:' || OLD.id));
        UPDATE continuity_facts
        SET status='revoked', text='', version=version+1, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            revision=(SELECT revision FROM continuity_pair_state WHERE user_id=continuity_facts.user_id AND character_id=continuity_facts.character_id AND instance_id=continuity_facts.instance_id)
        WHERE status<>'revoked' AND EXISTS (SELECT 1 FROM json_each(source_ids_json) source WHERE source.value='history:' || OLD.id);
      END;
    `);
    return new SqliteContinuityMemoryStore(db);
  }

  private ensurePair(pairing: PairingScope): StateRow {
    assertPairing(pairing);
    this.db.prepare('INSERT OR IGNORE INTO continuity_pair_state(user_id, character_id, instance_id) VALUES(?,?,?)').run(pairing.userId, pairing.characterId, pairing.characterInstanceId);
    return this.db.prepare('SELECT revision, epoch FROM continuity_pair_state WHERE user_id=? AND character_id=? AND instance_id=?').get(pairing.userId, pairing.characterId, pairing.characterInstanceId) as StateRow;
  }

  private bump(pairing: PairingScope): StateRow {
    this.db.prepare('UPDATE continuity_pair_state SET revision=revision+1, epoch=epoch+1 WHERE user_id=? AND character_id=? AND instance_id=?').run(pairing.userId, pairing.characterId, pairing.characterInstanceId);
    return this.ensurePair(pairing);
  }

  private now(): string { return new Date().toISOString(); }

  private readOperation(pairing: PairingScope, operationId: string, payload: unknown): ContinuityMutationResult | null {
    const prior = this.db.prepare('SELECT signature, result_json FROM continuity_operations WHERE user_id=? AND character_id=? AND instance_id=? AND operation_id=?').get(pairing.userId, pairing.characterId, pairing.characterInstanceId, operationId) as OperationRow | undefined;
    if (!prior) return null;
    const current = signature(payload);
    if (prior.signature !== current || !prior.result_json) throw new ContinuityMemoryError('version_conflict', '同一 operationId 已用于其他内容。');
    const replay = JSON.parse(prior.result_json) as ContinuityMutationResult;
    if (!replay.fact) return replay;
    const row = this.row(pairing, replay.fact.id);
    if (!row) throw new ContinuityMemoryError('version_conflict', '该操作引用的事实已失效。');
    if (row.status === 'revoked' && replay.fact.status === 'revoked') {
      // A repeated forget remains idempotent, but the receipt is rebuilt from the scrubbed row.
      return Object.freeze({ ...replay, fact: this.hydrate(row) });
    }
    const now = this.now();
    const activeCandidate = row.status === 'candidate' && row.evidence_eligible === 1
      && (!row.valid_from || Date.parse(row.valid_from) <= Date.parse(now))
      && (!row.valid_to || Date.parse(row.valid_to) > Date.parse(now))
      && this.sourcesCurrent(row, now);
    if (!this.activeFact(row, now) && !activeCandidate) {
      // Operation receipts are durable, while forget/correction/source expiry can happen later.
      // Never let an old successful response resurrect text that is no longer readable.
      throw new ContinuityMemoryError('version_conflict', '该操作引用的事实已失效。');
    }
    return Object.freeze({ ...replay, fact: this.hydrate(row) });
  }

  private saveOperation(pairing: PairingScope, operationId: string, payload: unknown, result: ContinuityMutationResult): void {
    this.db.prepare('INSERT INTO continuity_operations(user_id, character_id, instance_id, operation_id, signature, result_json) VALUES(?,?,?,?,?,?)')
      .run(pairing.userId, pairing.characterId, pairing.characterInstanceId, operationId, signature(payload), JSON.stringify(result));
  }

  private revokedSource(characterId: string, sourceId: string): boolean {
    try {
      const row = this.db.prepare("SELECT 1 AS found FROM character_source_revocations WHERE character_id=? AND target_type='source' AND target_id=? LIMIT 1").get(characterId, sourceId) as { found: number } | undefined;
      return Boolean(row);
    } catch { return false; }
  }

  /**
   * A continuity fact may itself be the source of a derived fact.  A tombstone on the
   * root is therefore not enough: every descendant must be excluded until it is rebuilt
   * from a still-current source.  Unknown source ids are ordinary external evidence
   * (message ids, imports, etc.) and remain governed by their owning store.
   */
  private invalidContinuitySource(pairing: PairingScope, sourceId: string, now: string, seen = new Set<string>()): boolean {
    if (seen.has(sourceId)) return true;
    seen.add(sourceId);
    if (sourceId.startsWith('history:')) {
      const historyId = sourceId.slice('history:'.length);
      if (!historyId) return true;
      try {
        const source = this.db.prepare('SELECT state, kind, message_role, evidence_eligible FROM memory_records WHERE character_id=? AND id=? LIMIT 1')
          .get(pairing.characterId, historyId) as { state: string; kind: string; message_role: string | null; evidence_eligible: number } | undefined;
        if (!source || source.state !== 'active' || source.kind !== 'transcript' || source.message_role !== 'user' || source.evidence_eligible !== 1) return true;
      } catch { return true; }
    }
    const row = this.db.prepare(
      'SELECT status, evidence_eligible, valid_from, valid_to, source_ids_json FROM continuity_facts WHERE user_id=? AND character_id=? AND instance_id=? AND id=? LIMIT 1',
    ).get(pairing.userId, pairing.characterId, pairing.characterInstanceId, sourceId) as {
      status: FactRow['status'];
      evidence_eligible: number;
      valid_from: string | null;
      valid_to: string | null;
      source_ids_json: string;
    } | undefined;
    if (!row) return false;
    if (row.status !== 'active' || row.evidence_eligible !== 1) return true;
    if (row.valid_from && Date.parse(row.valid_from) > Date.parse(now)) return true;
    if (row.valid_to && Date.parse(row.valid_to) <= Date.parse(now)) return true;
    let parents: string[] = [];
    try { parents = JSON.parse(row.source_ids_json) as string[]; } catch { return true; }
    return parents.some(parent => this.invalidContinuitySource(pairing, parent, now, new Set(seen)));
  }

  private hydrate(row: FactRow): ContinuityFact {
    const pairing = Object.freeze({ userId: row.user_id, characterId: row.character_id, characterInstanceId: row.instance_id });
    return Object.freeze({
      id: row.id, pairing, layer: row.layer, kind: row.kind, status: row.status, text: row.text,
      sourceIds: Object.freeze(JSON.parse(row.source_ids_json) as string[]), origin: row.origin,
      evidenceEligible: row.evidence_eligible === 1, createdAt: row.created_at, updatedAt: row.updated_at,
      ...(row.valid_from !== null ? { validFrom: row.valid_from } : {}),
      ...(row.valid_to !== null ? { validTo: row.valid_to } : {}),
      ...(row.supersedes_id !== null ? { supersedesId: row.supersedes_id } : {}),
      version: row.version, revision: row.revision,
    });
  }

  private row(pairing: PairingScope, id: string): FactRow | undefined {
    return this.db.prepare('SELECT * FROM continuity_facts WHERE user_id=? AND character_id=? AND instance_id=? AND id=?').get(pairing.userId, pairing.characterId, pairing.characterInstanceId, id) as FactRow | undefined;
  }

  private activeFact(row: FactRow, now: string): boolean {
    if (row.status !== 'active' || row.evidence_eligible !== 1) return false;
    if (row.valid_from && Date.parse(row.valid_from) > Date.parse(now)) return false;
    if (row.valid_to && Date.parse(row.valid_to) <= Date.parse(now)) return false;
    return this.sourcesCurrent(row, now);
  }

  private sourcesCurrent(row: FactRow, now: string): boolean {
    const sourceIds = JSON.parse(row.source_ids_json) as string[];
    const pairing = { userId: row.user_id, characterId: row.character_id, characterInstanceId: row.instance_id };
    return sourceIds.every(id => !this.revokedSource(row.character_id, id) && !this.invalidContinuitySource(pairing, id, now));
  }

  snapshot(pairing: PairingScope, options: { readonly includeCandidates?: boolean; readonly now?: string } = {}): ContinuityMemorySnapshot {
    const state = this.ensurePair(pairing);
    const now = options.now ?? this.now();
    const rows = this.db.prepare('SELECT * FROM continuity_facts WHERE user_id=? AND character_id=? AND instance_id=? ORDER BY updated_at ASC, id ASC')
      .all(pairing.userId, pairing.characterId, pairing.characterInstanceId) as FactRow[];
    const soul: ContinuityFact[] = [], wiki: ContinuityFact[] = [], relationship: ContinuityFact[] = [], candidates: ContinuityFact[] = [];
    for (const row of rows) {
      const fact = this.hydrate(row);
      if (row.status === 'candidate' && options.includeCandidates && row.evidence_eligible === 1 && this.sourcesCurrent(row, now)) candidates.push(fact);
      if (!this.activeFact(row, now)) continue;
      if (row.layer === 'user_soul') soul.push(fact);
      else if (row.layer === 'user_wiki') wiki.push(fact);
      else relationship.push(fact);
    }
    return Object.freeze({ pairing: Object.freeze({ ...pairing }), revision: state.revision, soul: Object.freeze(soul), wiki: Object.freeze(wiki), relationship: Object.freeze(relationship), candidates: Object.freeze(candidates) });
  }

  record(input: ContinuityRecordInput): ContinuityMutationResult {
    assertPairing(input.pairing); assertOperation(input.operationId); assertText(input.text);
    if (!isTime(input.validFrom) || !isTime(input.validTo)) throw new ContinuityMemoryError('invalid_request', '有效时间无效。');
    if (input.origin === 'assistant') throw new ContinuityMemoryError('forbidden', '助手自述不能直接建立用户事实。');
    const sourceIds = [...new Set(input.sourceIds ?? [])];
    if (input.kind === 'inference' && sourceIds.length === 0) throw new ContinuityMemoryError('invalid_request', '推断必须带证据来源。');
    if (sourceIds.some(id => typeof id !== 'string' || !id.trim())) throw new ContinuityMemoryError('invalid_request', '来源标识无效。');
    const now = this.now();
    if (sourceIds.some(id => this.revokedSource(input.pairing.characterId, id) || this.invalidContinuitySource(input.pairing, id, now))) throw new ContinuityMemoryError('version_conflict', '事实引用了已撤销或已失效来源。');
    const payload = { ...input, sourceIds, status: input.status ?? 'candidate', evidenceEligible: input.evidenceEligible ?? true };
    const existing = this.readOperation(input.pairing, input.operationId, payload); if (existing) return existing;
    const result = this.db.transaction(() => {
      const state = this.ensurePair(input.pairing);
      const revision = state.revision + 1;
      const id = `ctf-${randomUUID()}`;
      this.db.prepare('INSERT INTO continuity_facts (id,user_id,character_id,instance_id,layer,kind,status,text,source_ids_json,origin,evidence_eligible,created_at,updated_at,valid_from,valid_to,supersedes_id,version,revision) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, input.pairing.userId, input.pairing.characterId, input.pairing.characterInstanceId, input.layer, input.kind, payload.status, input.text, JSON.stringify(sourceIds), input.origin, payload.evidenceEligible ? 1 : 0, now, now, input.validFrom ?? null, input.validTo ?? null, null, 1, revision);
      this.bump(input.pairing);
      const fact = this.hydrate(this.row(input.pairing, id)!);
      const response: ContinuityMutationResult = Object.freeze({ status: 'applied', fact, revision: this.ensurePair(input.pairing).revision, affectedIds: Object.freeze([id]) });
      this.saveOperation(input.pairing, input.operationId, payload, response);
      return response;
    }).immediate();
    return result;
  }

  promote(pairing: PairingScope, operationId: string, targetId: string, expectedVersion: number): ContinuityMutationResult {
    assertPairing(pairing); assertOperation(operationId); assertText(targetId, 'targetId');
    const payload = { targetId, expectedVersion, kind: 'promote' };
    const existing = this.readOperation(pairing, operationId, payload); if (existing) return existing;
    const result = this.db.transaction(() => {
      const row = this.row(pairing, targetId);
      if (!row) throw new ContinuityMemoryError('not_found', '连续性条目不存在。');
      if (row.version !== expectedVersion || row.status !== 'candidate') throw new ContinuityMemoryError('version_conflict', '候选条目已变化。');
      const revision = this.ensurePair(pairing).revision + 1;
      this.db.prepare("UPDATE continuity_facts SET status='active', version=version+1, updated_at=?, revision=? WHERE id=?").run(this.now(), revision, targetId);
      this.bump(pairing);
      const fact = this.hydrate(this.row(pairing, targetId)!);
      const response: ContinuityMutationResult = Object.freeze({ status: 'applied', fact, revision: this.ensurePair(pairing).revision, affectedIds: Object.freeze([targetId]) });
      this.saveOperation(pairing, operationId, payload, response); return response;
    }).immediate();
    return result;
  }

  correct(input: ContinuityCorrectionInput): ContinuityMutationResult {
    assertPairing(input.pairing); assertOperation(input.operationId); assertText(input.targetId, 'targetId'); assertText(input.text); assertText(input.reason, 'reason');
    const payload = { ...input, sourceIds: [...new Set(input.sourceIds ?? [])] };
    const existing = this.readOperation(input.pairing, input.operationId, payload); if (existing) return existing;
    const result = this.db.transaction(() => {
      const old = this.row(input.pairing, input.targetId);
      if (!old) throw new ContinuityMemoryError('not_found', '连续性条目不存在。');
      if (old.version !== input.expectedVersion || old.status === 'revoked') throw new ContinuityMemoryError('version_conflict', '连续性条目已变化或已撤销。');
      const sourceIds = payload.sourceIds.length ? payload.sourceIds : JSON.parse(old.source_ids_json) as string[];
      const now = this.now();
      if (sourceIds.some(id => this.revokedSource(input.pairing.characterId, id) || this.invalidContinuitySource(input.pairing, id, now))) throw new ContinuityMemoryError('version_conflict', '修正引用了已撤销或已失效来源。');
      const revision = this.ensurePair(input.pairing).revision + 1, id = `ctf-${randomUUID()}`;
      this.db.prepare("UPDATE continuity_facts SET status='superseded', version=version+1, updated_at=?, revision=? WHERE id=?").run(now, revision, input.targetId);
      this.db.prepare('INSERT INTO continuity_facts (id,user_id,character_id,instance_id,layer,kind,status,text,source_ids_json,origin,evidence_eligible,created_at,updated_at,valid_from,valid_to,supersedes_id,version,revision) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, input.pairing.userId, input.pairing.characterId, input.pairing.characterInstanceId, old.layer, old.kind, 'active', input.text, JSON.stringify(sourceIds), 'manual', 1, old.created_at, now, old.valid_from, old.valid_to, input.targetId, 1, revision);
      this.bump(input.pairing);
      const fact = this.hydrate(this.row(input.pairing, id)!);
      const response: ContinuityMutationResult = Object.freeze({ status: 'applied', fact, revision: this.ensurePair(input.pairing).revision, affectedIds: Object.freeze([input.targetId, id]) });
      this.saveOperation(input.pairing, input.operationId, payload, response); return response;
    }).immediate();
    return result;
  }

  forget(input: ContinuityForgetInput): ContinuityMutationResult {
    assertPairing(input.pairing); assertOperation(input.operationId); assertText(input.targetId, 'targetId'); assertText(input.reason, 'reason');
    const payload = input;
    const existing = this.readOperation(input.pairing, input.operationId, payload); if (existing) return existing;
    const result = this.db.transaction(() => {
      const row = this.row(input.pairing, input.targetId);
      if (!row) throw new ContinuityMemoryError('not_found', '连续性条目不存在。');
      if (row.version !== input.expectedVersion || row.status === 'revoked') throw new ContinuityMemoryError('version_conflict', '连续性条目已变化或已撤销。');
      const now = this.now(), revision = this.ensurePair(input.pairing).revision + 1;
      this.db.prepare("UPDATE continuity_facts SET status='revoked', text='', version=version+1, updated_at=?, revision=? WHERE id=?").run(now, revision, input.targetId);
      this.db.prepare('INSERT OR REPLACE INTO continuity_tombstones(user_id,character_id,instance_id,fact_id,reason,revoked_at) VALUES(?,?,?,?,?,?)').run(input.pairing.userId, input.pairing.characterId, input.pairing.characterInstanceId, input.targetId, input.reason, now);
      this.bump(input.pairing);
      const fact = this.hydrate(this.row(input.pairing, input.targetId)!);
      const response: ContinuityMutationResult = Object.freeze({ status: 'applied', fact, revision: this.ensurePair(input.pairing).revision, affectedIds: Object.freeze([input.targetId]) });
      this.saveOperation(input.pairing, input.operationId, payload, response); return response;
    }).immediate();
    return result;
  }

  beginDerived(pairing: PairingScope): ContinuityLease {
    const state = this.ensurePair(pairing);
    return Object.freeze({ pairing: Object.freeze({ ...pairing }), revision: state.revision, epoch: state.epoch });
  }

  assertCurrent(lease: ContinuityLease): void {
    assertPairing(lease.pairing);
    const state = this.ensurePair(lease.pairing);
    if (state.revision !== lease.revision || state.epoch !== lease.epoch) throw new ContinuityMemoryError('version_conflict', '后台连续性结果已过期。');
  }

  commitDerived(input: ContinuityDerivedCommit): ContinuityMutationResult {
    this.assertCurrent(input.lease);
    return this.record({ pairing: input.lease.pairing, operationId: input.operationId, layer: input.layer, kind: input.kind, text: input.text, sourceIds: input.sourceIds, origin: 'derived', status: input.status ?? 'candidate' });
  }
}

export { SqliteContinuityMemoryStore as ContinuityMemoryStore };
