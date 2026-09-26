import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ContinuityMemoryPort, ContinuityLayer } from '../contracts/continuity-memory.js';
import type { PairingScope } from '../contracts/character-pack.js';
import type { TurnScope } from '../contracts/index.js';
import type { SqliteMemoryStore } from './sqlite-store.js';

interface CandidateSource {
  readonly id: string;
  readonly state: string;
  readonly kind: string;
  readonly role: string | null;
  readonly text: string;
  readonly evidenceEligible: number;
}
interface OutboxRow { readonly user_id: string; readonly character_id: string; readonly instance_id: string; readonly source_id: string; }

/**
 * Converts a deliberately small set of direct first-person statements into review candidates.
 * It stores only source IDs in the outbox, quotes source text verbatim, and never promotes facts.
 */
export class ConversationCandidateWriter {
  readonly #db: Database.Database;

  constructor(
    private readonly history: Pick<SqliteMemoryStore, 'rawDatabaseForKnowledge'>,
    private readonly continuity: ContinuityMemoryPort,
    private readonly pairingForCharacter: (characterId: string) => PairingScope,
  ) {
    this.#db = history.rawDatabaseForKnowledge();
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS continuity_conversation_candidate_checkpoint (
        user_id TEXT NOT NULL, character_id TEXT NOT NULL, instance_id TEXT NOT NULL,
        logical_order INTEGER NOT NULL,
        PRIMARY KEY(user_id, character_id, instance_id)
      );
      CREATE TABLE IF NOT EXISTS continuity_conversation_candidate_outbox (
        user_id TEXT NOT NULL, character_id TEXT NOT NULL, instance_id TEXT NOT NULL,
        source_id TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(user_id, character_id, instance_id, source_id)
      );
    `);
  }

  /** Sets the first-run boundary so installing this feature never turns old chat history into facts. */
  initialize(pairing: PairingScope): void {
    this.#db.transaction(() => {
      const existing = this.#db.prepare('SELECT 1 AS found FROM continuity_conversation_candidate_checkpoint WHERE user_id=? AND character_id=? AND instance_id=?')
        .get(pairing.userId, pairing.characterId, pairing.characterInstanceId) as { found: number } | undefined;
      if (existing) return;
      const highWater = this.#highWater(pairing.characterId);
      this.#db.prepare('INSERT INTO continuity_conversation_candidate_checkpoint(user_id,character_id,instance_id,logical_order) VALUES(?,?,?,?)')
        .run(pairing.userId, pairing.characterId, pairing.characterInstanceId, highWater);
    }).immediate();
  }

  /** Durable stage + drain; calling it repeatedly is safe across callback retries and process restarts. */
  recover(pairing: PairingScope): { readonly staged: number; readonly processed: number; readonly pending: number } {
    const staged = this.stage(pairing);
    const rows = this.#db.prepare('SELECT * FROM continuity_conversation_candidate_outbox WHERE user_id=? AND character_id=? AND instance_id=? ORDER BY created_at,source_id')
      .all(pairing.userId, pairing.characterId, pairing.characterInstanceId) as OutboxRow[];
    let processed = 0;
    for (const row of rows) {
      const source = this.#source(pairing.characterId, row.source_id);
      if (!source || source.state !== 'active' || source.kind !== 'transcript' || source.role !== 'user' || source.evidenceEligible !== 1) {
        this.#deleteOutbox(row);
        processed += 1;
        continue;
      }
      const candidates = extractConversationCandidates(source.text);
      for (const candidate of candidates) {
        const operationId = candidateOperationId(pairing, source.id, candidate.layer, candidate.text);
        const lease = this.continuity.beginDerived(pairing);
        this.continuity.commitDerived({
          lease,
          operationId,
          layer: candidate.layer,
          kind: 'fact',
          text: candidate.text,
          sourceIds: [`history:${source.id}`],
          status: 'candidate',
        });
      }
      this.#deleteOutbox(row);
      processed += 1;
    }
    const pending = (this.#db.prepare('SELECT COUNT(*) AS count FROM continuity_conversation_candidate_outbox WHERE user_id=? AND character_id=? AND instance_id=?')
      .get(pairing.userId, pairing.characterId, pairing.characterInstanceId) as { count: number }).count;
    return Object.freeze({ staged, processed, pending });
  }

  /** Called only after the production History append has completed. The outbox persists before facts. */
  afterConversationSaved(scope: TurnScope): { readonly staged: number; readonly processed: number; readonly pending: number } {
    const pairing = this.pairingForCharacter(scope.characterId);
    this.initialize(pairing);
    return this.recover(pairing);
  }

  /** Stages newly saved user transcript IDs and advances the checkpoint in one SQLite transaction. */
  stage(pairing: PairingScope): number {
    return this.#db.transaction(() => {
      let checkpoint = this.#db.prepare('SELECT logical_order FROM continuity_conversation_candidate_checkpoint WHERE user_id=? AND character_id=? AND instance_id=?')
        .get(pairing.userId, pairing.characterId, pairing.characterInstanceId) as { logical_order: number } | undefined;
      if (!checkpoint) {
        this.initialize(pairing);
        checkpoint = this.#db.prepare('SELECT logical_order FROM continuity_conversation_candidate_checkpoint WHERE user_id=? AND character_id=? AND instance_id=?')
          .get(pairing.userId, pairing.characterId, pairing.characterInstanceId) as { logical_order: number };
      }
      const highWater = this.#highWater(pairing.characterId);
      if (highWater <= checkpoint.logical_order) return 0;
      const fresh = this.#db.prepare(`SELECT id,kind,state,message_role,evidence_eligible FROM memory_records
        WHERE character_id=? AND logical_order>? AND logical_order<=? ORDER BY logical_order,id`)
        .all(pairing.characterId, checkpoint.logical_order, highWater) as { id: string; kind: string; state: string; message_role: string | null; evidence_eligible: number }[];
      let staged = 0;
      const insert = this.#db.prepare('INSERT OR IGNORE INTO continuity_conversation_candidate_outbox(user_id,character_id,instance_id,source_id) VALUES(?,?,?,?)');
      for (const record of fresh) {
        if (record.kind !== 'transcript' || record.state !== 'active' || record.message_role !== 'user' || record.evidence_eligible !== 1) continue;
        staged += insert.run(pairing.userId, pairing.characterId, pairing.characterInstanceId, record.id).changes;
      }
      this.#db.prepare('UPDATE continuity_conversation_candidate_checkpoint SET logical_order=? WHERE user_id=? AND character_id=? AND instance_id=?')
        .run(highWater, pairing.userId, pairing.characterId, pairing.characterInstanceId);
      return staged;
    }).immediate();
  }

  #highWater(characterId: string): number {
    return (this.#db.prepare('SELECT COALESCE(MAX(logical_order),0) AS value FROM memory_records WHERE character_id=?').get(characterId) as { value: number }).value;
  }

  #source(characterId: string, sourceId: string): CandidateSource | undefined {
    const row = this.#db.prepare('SELECT id,state,kind,message_role AS role,text,evidence_eligible AS evidenceEligible FROM memory_records WHERE character_id=? AND id=? LIMIT 1')
      .get(characterId, sourceId) as CandidateSource | undefined;
    return row;
  }

  #deleteOutbox(row: OutboxRow): void {
    this.#db.prepare('DELETE FROM continuity_conversation_candidate_outbox WHERE user_id=? AND character_id=? AND instance_id=? AND source_id=?')
      .run(row.user_id, row.character_id, row.instance_id, row.source_id);
  }
}

/** Exact-message extraction: no model inference, summarization, paraphrase, or automatic promotion. */
export function extractConversationCandidates(text: string): readonly { readonly layer: ContinuityLayer; readonly text: string }[] {
  if (typeof text !== 'string' || text.length === 0 || text.length > 16_000) return Object.freeze([]);
  const statements = text.split(/(?<=[。！？!?；;\n])/u).map(value => value.trim()).filter(Boolean);
  const result: { layer: ContinuityLayer; text: string }[] = [];
  for (const statement of statements) {
    if (statement.length > 240 || isSensitive(statement)) continue;
    let layer: ContinuityLayer | undefined;
    if (/^(?:我长期目标是|我的长期目标是|我最重视|对我来说最重要的是|我珍惜|我始终相信|我的价值观是|我希望长期)/u.test(statement)
      || /^(?:My long-term goal is|What matters most to me is|I value)\b/i.test(statement)) layer = 'user_soul';
    else if (/^(?:我叫|我的名字是|我名叫|我的职业是|我的工作是|我从事|我喜欢|我很喜欢|我不喜欢|我偏好|我习惯于)/u.test(statement)
      || /^(?:My name is|I work as|I like|I love|I prefer)\b/i.test(statement)) layer = 'user_wiki';
    if (layer) result.push(Object.freeze({ layer, text: statement }));
  }
  return Object.freeze(result);
}

function isSensitive(text: string): boolean {
  return /(?:[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|\b\d{17}[\dXx]\b|(?:\+?\d[\s-]?){9,}|住址|家庭住址|详细地址|身份证|银行卡|卡号|密码|验证码|病史|疾病|诊断|病情|收入|薪资|工资|私钥|密钥)/iu.test(text);
}

function candidateOperationId(pairing: PairingScope, sourceId: string, layer: ContinuityLayer, text: string): string {
  const digest = createHash('sha256').update(JSON.stringify([pairing.userId, pairing.characterId, pairing.characterInstanceId, sourceId, layer, text])).digest('hex');
  return `conversation-candidate:${digest}`;
}
