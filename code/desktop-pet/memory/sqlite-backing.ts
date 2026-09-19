import type Database from 'better-sqlite3';
import type { CharacterId } from '../contracts/index.js';
import type { LedgerBacking, RecordCollection } from './backing.js';
import type { MemoryRecord, RecordKind, SourceVersion } from './ledger.js';

export interface RecordRow {
  character_id: CharacterId; id: string; kind: RecordKind; state: MemoryRecord['state']; version: number;
  text: string; sources_json: string; created_at: string; deleted_at: string | null; reason: string | null;
  message_role: 'user' | 'assistant' | null; perception_json: string | null;
  evidence_eligible: number; logical_order: number; fragment_json: string | null;
  origin?: MemoryRecord['origin'] | null;
}
export function decodeRecord(row: RecordRow): MemoryRecord {
  return { ...(row.origin?{origin:row.origin}:{}),characterId: row.character_id, id: row.id, kind: row.kind, state: row.state, version: row.version, text: row.text,
    evidenceEligible: row.evidence_eligible === 1, logicalOrder: row.logical_order, fragment: row.fragment_json ? JSON.parse(row.fragment_json) : null,
    sources: JSON.parse(row.sources_json), createdAt: row.created_at, deletedAt: row.deleted_at, reason: row.reason,
    message: row.message_role ? { ...(row.origin?{origin:row.origin}:{}),characterId: row.character_id, id: row.id, role: row.message_role, text: row.text, createdAt: row.created_at } : null,
    perception: row.perception_json ? JSON.parse(row.perception_json) : null };
}

/** All content queries bind character_id, including lineage; global accounting is outside this backing. */
export class SqliteLedgerBacking implements LedgerBacking {
  readonly records: RecordCollection;
  readonly operations: LedgerBacking['operations'];
  constructor(private readonly db: Database.Database, readonly characterId: CharacterId) {
    this.records = {
      get: id => { const row = db.prepare('SELECT * FROM memory_records WHERE character_id=? AND id=?').get(characterId, id) as RecordRow | undefined; return row && decodeRecord(row); },
      has: id => !!db.prepare('SELECT 1 FROM memory_records WHERE character_id=? AND id=?').get(characterId, id),
      set: (id, record) => {
        if (record.characterId !== characterId || id !== record.id) throw new Error('backing_character_mismatch');
        // One copy of raw text, never a second JSON message payload outside the transcript quota.
        db.prepare(`INSERT INTO memory_records(character_id,id,kind,state,version,text,sources_json,created_at,created_ms,deleted_at,deleted_ms,reason,message_role,perception_json,transcript_bytes,evidence_eligible,logical_order,fragment_json,origin)
          VALUES(@characterId,@id,@kind,@state,@version,@text,@sources,@createdAt,@createdMs,@deletedAt,@deletedMs,@reason,@messageRole,@perception,@bytes,@eligible,coalesce(@logicalOrder,(SELECT coalesce(max(logical_order),0)+1 FROM memory_records)),@fragment,@origin)
          ON CONFLICT(character_id,id) DO UPDATE SET kind=excluded.kind,state=excluded.state,version=excluded.version,text=excluded.text,sources_json=excluded.sources_json,
          deleted_at=excluded.deleted_at,deleted_ms=excluded.deleted_ms,reason=excluded.reason,message_role=excluded.message_role,perception_json=excluded.perception_json,transcript_bytes=excluded.transcript_bytes,evidence_eligible=excluded.evidence_eligible,logical_order=excluded.logical_order,fragment_json=excluded.fragment_json,origin=excluded.origin`).run({
          characterId, id, kind: record.kind, state: record.state, version: record.version, text: record.text, sources: JSON.stringify(record.sources), createdAt: record.createdAt,
          createdMs: Date.parse(record.createdAt), deletedAt: record.deletedAt, deletedMs: record.deletedAt ? Date.parse(record.deletedAt) : null, reason: record.reason,
          messageRole: record.message?.role ?? null, perception: record.perception ? JSON.stringify(record.perception) : null,
          eligible: (record.evidenceEligible ?? (record.message?.role !== 'assistant' || record.sources.length > 0)) ? 1 : 0,
          logicalOrder: record.logicalOrder ?? null, fragment: record.fragment ? JSON.stringify(record.fragment) : null, origin:record.origin??null,
          bytes: record.kind === 'transcript' ? Buffer.byteLength(record.text, 'utf8') : 0,
        });
      },
      select: (kind, state) => (db.prepare('SELECT * FROM memory_records WHERE character_id=? AND (? IS NULL OR kind=?) AND (? IS NULL OR state=?) ORDER BY rowid').all(characterId, kind ?? null, kind ?? null, state ?? null, state ?? null) as RecordRow[]).map(decodeRecord),
      lineage: () => (db.prepare('SELECT id,sources_json FROM memory_records WHERE character_id=?').all(characterId) as {id: string; sources_json: string}[]).map(row => ({ id: row.id, sources: JSON.parse(row.sources_json) as SourceVersion[] })),
    };
    this.operations = {
      has: id => !!db.prepare('SELECT 1 FROM memory_operations WHERE character_id=? AND operation_id=?').get(characterId, id),
      add: id => db.prepare('INSERT INTO memory_operations(character_id,operation_id) VALUES(?,?)').run(characterId, id),
    };
  }
  get revision(): number { return (this.db.prepare('SELECT revision FROM characters WHERE character_id=?').get(this.characterId) as {revision: number}).revision; }
  set revision(value: number) { this.db.prepare('UPDATE characters SET revision=? WHERE character_id=?').run(value, this.characterId); }
  get epoch(): number { return (this.db.prepare('SELECT epoch FROM characters WHERE character_id=?').get(this.characterId) as {epoch: number}).epoch; }
  set epoch(value: number) { this.db.prepare('UPDATE characters SET epoch=? WHERE character_id=?').run(value, this.characterId); }
}
