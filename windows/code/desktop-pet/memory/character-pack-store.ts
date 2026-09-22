// N07-01 / N07-03: SQLite persistence for Character Pack drafts, source snapshots,
// activated immutable character packs, character instances, dual timelines, and continuity snapshots.
// Implements ContinuityReadPort, atomic activation/upgrade/rollback, and revocation awareness.

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  CanonAwareness,
  CanonTimelineEvent,
  CharacterInstance,
  CharacterPack,
  CharacterPackDraft,
  CharacterPackDraftPayload,
  CompanionTimelineEvent,
  ContinuityReadPort,
  ContinuitySnapshot,
  DraftStatus,
  DraftValidationResult,
  PairingScope,
  SourceBlock,
  SourceBlockLocator,
  SourceImportInput,
  SourceLimits,
  SourceSnapshot,
} from '../contracts/character-pack.js';
import {
  CharacterPackError,
  DEFAULT_SOURCE_LIMITS,
} from '../contracts/character-pack.js';
import {
  createSourceSnapshot,
  sha256,
  splitSourceBlocks,
  validateSourceInput,
} from './character-pack-source.js';
import { computeCutoffAllowedBlockIds } from './character-pack-validator.js';

interface SourceRow {
  id: string;
  character_id: string;
  source_name: string;
  content_hash: string;
  body: string;
  byte_length: number;
  created_at: string;
}

interface BlockRow {
  id: string;
  source_id: string;
  ordinal: number;
  block_hash: string;
  text: string;
  start_offset: number;
  end_offset: number;
  chapter: string | null;
  line: number | null;
}

interface DraftRow {
  id: string;
  character_id: string;
  pack_version: string;
  schema_version: string;
  status: string;
  payload_json: string;
  source_ids_json: string;
  validation_json: string;
  created_at: string;
  updated_at: string;
}

interface PackRow {
  id: string;
  character_id: string;
  pack_version: string;
  schema_version: string;
  name: string;
  soul: string;
  style_hints_json: string | null;
  canon_facts_json: string;
  canon_timeline_json: string;
  gaps_json: string;
  source_ids_json: string;
  source_hashes_json: string;
  cutoff_point: string | null;
  work_title: string | null;
  draft_id: string | null;
  activated_at: string | null;
  created_at: string;
}

interface InstanceRow {
  instance_id: string;
  user_id: string;
  character_id: string;
  active_pack_id: string | null;
  active_pack_version: string | null;
  created_at: string;
  updated_at: string;
}

interface CompanionEventRow {
  event_id: string;
  user_id: string;
  character_id: string;
  character_instance_id: string;
  session_id: string;
  turn_id: string;
  user_text: string;
  assistant_text: string;
  created_at: string;
  source_ids_json: string | null;
}

export class CharacterPackStore implements ContinuityReadPort {
  private constructor(private readonly db: Database.Database) {}

  static async open(
    target: Database.Database | { rawDatabaseForKnowledge(): Database.Database },
  ): Promise<CharacterPackStore> {
    const db = 'rawDatabaseForKnowledge' in target ? target.rawDatabaseForKnowledge() : target;

    db.exec(`
      CREATE TABLE IF NOT EXISTS character_pack_sources (
        id TEXT PRIMARY KEY,
        character_id TEXT NOT NULL,
        source_name TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        body TEXT NOT NULL,
        byte_length INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pack_sources_char_hash 
        ON character_pack_sources(character_id, content_hash);

      CREATE TABLE IF NOT EXISTS character_pack_source_blocks (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES character_pack_sources(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        block_hash TEXT NOT NULL,
        text TEXT NOT NULL,
        start_offset INTEGER NOT NULL,
        end_offset INTEGER NOT NULL,
        chapter TEXT,
        line INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_pack_blocks_source 
        ON character_pack_source_blocks(source_id);

      CREATE TABLE IF NOT EXISTS character_pack_drafts (
        id TEXT PRIMARY KEY,
        character_id TEXT NOT NULL,
        pack_version TEXT NOT NULL,
        schema_version TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('draft', 'validated', 'rejected')),
        payload_json TEXT NOT NULL,
        source_ids_json TEXT NOT NULL,
        validation_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pack_drafts_char 
        ON character_pack_drafts(character_id);

      CREATE TABLE IF NOT EXISTS character_packs (
        id TEXT PRIMARY KEY,
        character_id TEXT NOT NULL,
        pack_version TEXT NOT NULL,
        schema_version TEXT NOT NULL,
        name TEXT NOT NULL,
        soul TEXT NOT NULL,
        style_hints_json TEXT,
        canon_facts_json TEXT NOT NULL,
        canon_timeline_json TEXT NOT NULL,
        gaps_json TEXT NOT NULL,
        source_ids_json TEXT NOT NULL,
        source_hashes_json TEXT NOT NULL,
        cutoff_point TEXT,
        work_title TEXT,
        draft_id TEXT,
        activated_at TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(character_id, pack_version)
      );
      CREATE INDEX IF NOT EXISTS idx_packs_char_ver ON character_packs(character_id, pack_version);

      CREATE TABLE IF NOT EXISTS character_instances (
        instance_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        character_id TEXT NOT NULL,
        active_pack_id TEXT REFERENCES character_packs(id),
        active_pack_version TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(user_id, character_id, instance_id)
      );

      CREATE TABLE IF NOT EXISTS character_pack_history (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        character_id TEXT NOT NULL,
        instance_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK(action IN ('activate', 'upgrade', 'rollback')),
        from_pack_id TEXT,
        to_pack_id TEXT NOT NULL REFERENCES character_packs(id),
        reason TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS character_companion_timeline (
        event_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        character_id TEXT NOT NULL,
        character_instance_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        user_text TEXT NOT NULL,
        assistant_text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        source_ids_json TEXT NOT NULL DEFAULT '[]'
      );
      CREATE INDEX IF NOT EXISTS idx_companion_timeline 
        ON character_companion_timeline(user_id, character_id, character_instance_id, created_at);

      CREATE TABLE IF NOT EXISTS character_source_revocations (
        id TEXT PRIMARY KEY,
        character_id TEXT NOT NULL,
        target_type TEXT NOT NULL CHECK(target_type IN ('source', 'block')),
        target_id TEXT NOT NULL,
        reason TEXT,
        revoked_at TEXT NOT NULL,
        UNIQUE(character_id, target_type, target_id)
      );
    `);
    const timelineColumns = db.pragma('table_info(character_companion_timeline)') as { name: string }[];
    if (!timelineColumns.some(column => column.name === 'source_ids_json')) db.exec("ALTER TABLE character_companion_timeline ADD COLUMN source_ids_json TEXT NOT NULL DEFAULT '[]'");

    return new CharacterPackStore(db);
  }

  // --- Source Operations -----------------------------------------------------

  async importSource(
    characterId: string,
    input: SourceImportInput,
    limits: SourceLimits = DEFAULT_SOURCE_LIMITS,
  ): Promise<{ snapshot: SourceSnapshot; isDuplicate: boolean }> {
    const trimmedCharId = (characterId || '').trim();
    if (!trimmedCharId) {
      throw new CharacterPackError('invalid_request', 'characterId 不能为空。');
    }

    const meta = validateSourceInput(input, limits);

    const existing = this.db
      .prepare('SELECT id FROM character_pack_sources WHERE character_id=? AND content_hash=?')
      .get(trimmedCharId, meta.contentHash) as { id: string } | undefined;

    if (existing) {
      const snapshot = this.getSource(existing.id);
      if (snapshot) {
        return { snapshot, isDuplicate: true };
      }
    }

    const sourceId = `src-${randomUUID()}`;
    const now = new Date().toISOString();
    const blocks = splitSourceBlocks(input.text, sourceId, limits.maxBlockCodePoints);

    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO character_pack_sources (id, character_id, source_name, content_hash, body, byte_length, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(sourceId, trimmedCharId, meta.sourceName, meta.contentHash, input.text, meta.byteLength, now);

      const insertBlock = this.db.prepare(
        `INSERT INTO character_pack_source_blocks (id, source_id, ordinal, block_hash, text, start_offset, end_offset, chapter, line)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );

      for (const block of blocks) {
        insertBlock.run(
          block.id,
          sourceId,
          block.ordinal,
          block.blockHash,
          block.text,
          block.locator.start,
          block.locator.end,
          block.locator.chapter ?? null,
          block.locator.line ?? null,
        );
      }
    }).immediate();

    const snapshot = this.getSource(sourceId);
    if (!snapshot) {
      throw new CharacterPackError('not_found', '写入后无法检索来源快照。');
    }

    return { snapshot, isDuplicate: false };
  }

  async importSources(
    characterId: string,
    inputs: readonly SourceImportInput[],
    limits: SourceLimits = DEFAULT_SOURCE_LIMITS,
  ): Promise<{ snapshots: readonly SourceSnapshot[]; duplicates: readonly string[] }> {
    const trimmedCharId = (characterId || '').trim();
    if (!trimmedCharId) {
      throw new CharacterPackError('invalid_request', 'characterId 不能为空。');
    }
    if (!Array.isArray(inputs) || inputs.length === 0) {
      throw new CharacterPackError('invalid_request', '必须提供至少一个导入文件。');
    }
    if (inputs.length > limits.maxFilesPerImport) {
      throw new CharacterPackError(
        'source_limit_exceeded',
        `单次最多导入 ${limits.maxFilesPerImport} 个文件，当前提供了 ${inputs.length} 个。`,
      );
    }

    const prepared = inputs.map(input => {
      const meta = validateSourceInput(input, limits);
      return { input, meta };
    });

    const snapshots: SourceSnapshot[] = [];
    const duplicates: string[] = [];
    const now = new Date().toISOString();

    this.db.transaction(() => {
      for (const item of prepared) {
        const existing = this.db
          .prepare('SELECT id FROM character_pack_sources WHERE character_id=? AND content_hash=?')
          .get(trimmedCharId, item.meta.contentHash) as { id: string } | undefined;

        if (existing) {
          const snapshot = this.getSource(existing.id);
          if (snapshot) {
            snapshots.push(snapshot);
            duplicates.push(item.meta.sourceName);
            continue;
          }
        }

        const sourceId = `src-${randomUUID()}`;
        const blocks = splitSourceBlocks(item.input.text, sourceId, limits.maxBlockCodePoints);

        this.db
          .prepare(
            `INSERT INTO character_pack_sources (id, character_id, source_name, content_hash, body, byte_length, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(sourceId, trimmedCharId, item.meta.sourceName, item.meta.contentHash, item.input.text, item.meta.byteLength, now);

        const insertBlock = this.db.prepare(
          `INSERT INTO character_pack_source_blocks (id, source_id, ordinal, block_hash, text, start_offset, end_offset, chapter, line)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );

        for (const block of blocks) {
          insertBlock.run(
            block.id,
            sourceId,
            block.ordinal,
            block.blockHash,
            block.text,
            block.locator.start,
            block.locator.end,
            block.locator.chapter ?? null,
            block.locator.line ?? null,
          );
        }

        const snapshot = this.getSource(sourceId);
        if (snapshot) {
          snapshots.push(snapshot);
        }
      }
    }).immediate();

    return {
      snapshots: Object.freeze(snapshots),
      duplicates: Object.freeze(duplicates),
    };
  }

  getSource(sourceId: string): SourceSnapshot | null {
    const row = this.db
      .prepare('SELECT * FROM character_pack_sources WHERE id=?')
      .get(sourceId) as SourceRow | undefined;

    if (!row) return null;

    const blockRows = this.db
      .prepare('SELECT * FROM character_pack_source_blocks WHERE source_id=? ORDER BY ordinal')
      .all(sourceId) as BlockRow[];

    const blocks: SourceBlock[] = blockRows.map(b => {
      const locator: SourceBlockLocator = Object.freeze({
        start: b.start_offset,
        end: b.end_offset,
        ...(b.chapter !== null ? { chapter: b.chapter } : {}),
        ...(b.line !== null ? { line: b.line } : {}),
      });

      return Object.freeze({
        id: b.id,
        sourceId: b.source_id,
        ordinal: b.ordinal,
        text: b.text,
        blockHash: b.block_hash,
        locator,
      });
    });

    return Object.freeze({
      id: row.id,
      characterId: row.character_id,
      sourceName: row.source_name,
      contentHash: row.content_hash,
      byteLength: row.byte_length,
      createdAt: row.created_at,
      blocks: Object.freeze(blocks),
    });
  }

  listSources(characterId: string): readonly SourceSnapshot[] {
    const rows = this.db
      .prepare('SELECT id FROM character_pack_sources WHERE character_id=? ORDER BY created_at')
      .all(characterId) as { id: string }[];

    return Object.freeze(
      rows
        .map(r => this.getSource(r.id))
        .filter((s): s is SourceSnapshot => s !== null),
    );
  }

  // --- Draft Operations ------------------------------------------------------

  async saveDraft(params: {
    readonly characterId: string;
    readonly payload: CharacterPackDraftPayload;
    readonly sourceIds: readonly string[];
    readonly validation: DraftValidationResult;
    readonly packVersion?: string | undefined;
    readonly draftId?: string | undefined;
  }): Promise<CharacterPackDraft> {
    const characterId = (params.characterId || '').trim();
    if (!characterId) {
      throw new CharacterPackError('invalid_request', 'characterId 不能为空。');
    }

    const draftId = params.draftId || `cpd-${randomUUID()}`;
    const packVersion = params.packVersion || `draft-${randomUUID()}`;
    const schemaVersion = params.payload.schemaVersion || '0.7-draft-1';
    const status: DraftStatus = params.validation.valid ? 'validated' : 'rejected';
    const now = new Date().toISOString();

    const payloadJson = JSON.stringify(params.payload);
    const sourceIdsJson = JSON.stringify(params.sourceIds);
    const validationJson = JSON.stringify(params.validation);

    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO character_pack_drafts 
           (id, character_id, pack_version, schema_version, status, payload_json, source_ids_json, validation_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          draftId,
          characterId,
          packVersion,
          schemaVersion,
          status,
          payloadJson,
          sourceIdsJson,
          validationJson,
          now,
          now,
        );
    }).immediate();

    const saved = this.getDraft(draftId);
    if (!saved) {
      throw new CharacterPackError('not_found', '写入后无法检索草稿。');
    }
    return saved;
  }

  getDraft(draftId: string): CharacterPackDraft | null {
    const row = this.db
      .prepare('SELECT * FROM character_pack_drafts WHERE id=?')
      .get(draftId) as DraftRow | undefined;

    if (!row) return null;

    let payload: CharacterPackDraftPayload;
    let sourceIds: string[];
    let validation: DraftValidationResult;

    try {
      payload = JSON.parse(row.payload_json);
      sourceIds = JSON.parse(row.source_ids_json);
      validation = JSON.parse(row.validation_json);
    } catch {
      throw new CharacterPackError('version_conflict', `草稿 ${draftId} 的 JSON 数据已损坏。`);
    }

    return Object.freeze({
      id: row.id,
      characterId: row.character_id,
      packVersion: row.pack_version,
      schemaVersion: row.schema_version,
      status: row.status as DraftStatus,
      payload: Object.freeze(payload),
      sourceIds: Object.freeze(sourceIds),
      validation: Object.freeze(validation),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }

  listDrafts(characterId: string): readonly CharacterPackDraft[] {
    const rows = this.db
      .prepare('SELECT id FROM character_pack_drafts WHERE character_id=? ORDER BY created_at DESC')
      .all(characterId) as { id: string }[];

    return Object.freeze(
      rows
        .map(r => this.getDraft(r.id))
        .filter((d): d is CharacterPackDraft => d !== null),
    );
  }

  deleteDraft(draftId: string): boolean {
    const info = this.db.prepare('DELETE FROM character_pack_drafts WHERE id=?').run(draftId);
    return info.changes > 0;
  }

  // --- N07-03 Activation, Versioning, Instances, and Rollback ----------------

  /**
   * Generates a preview projection of how a draft would look as an activated CharacterPack.
   */
  async previewDraft(draftId: string): Promise<{
    readonly draft: CharacterPackDraft;
    readonly packPreview: CharacterPack;
    readonly warnings: readonly string[];
  }> {
    const draft = this.getDraft(draftId);
    if (!draft) {
      throw new CharacterPackError('not_found', `未找到草稿: "${draftId}"`);
    }

    const warnings: string[] = [];
    if (!draft.validation.valid) {
      warnings.push('草稿验证未通过，激活将直接失败。');
    }

    // Check for revoked sources
    for (const srcId of draft.sourceIds) {
      if (this.isSourceRevoked(draft.characterId, srcId)) {
        warnings.push(`草稿依赖的来源 "${srcId}" 已被撤销。`);
      }
    }

    const sourceHashes: string[] = [];
    for (const srcId of draft.sourceIds) {
      const src = this.getSource(srcId);
      if (src) sourceHashes.push(src.contentHash);
    }

    const canonTimeline = this.deriveCanonTimeline(draft.payload);

    const packPreview: CharacterPack = Object.freeze({
      id: `preview-${draft.id}`,
      characterId: draft.characterId,
      packVersion: 'preview',
      schemaVersion: draft.schemaVersion,
      name: draft.payload.character.name,
      soul: draft.payload.character.soul,
      styleHints: draft.payload.character.styleHints,
      canonFacts: draft.payload.canonFacts,
      canonTimeline,
      gaps: draft.payload.gaps,
      sourceIds: draft.sourceIds,
      sourceHashes: Object.freeze(sourceHashes),
      cutoffPoint: draft.payload.cutoffPoint,
      workTitle: draft.payload.workTitle,
      draftId: draft.id,
      createdAt: new Date().toISOString(),
    });

    return Object.freeze({
      draft,
      packPreview,
      warnings: Object.freeze(warnings),
    });
  }

  /**
   * Activates or upgrades a validated CharacterPackDraft into an immutable CharacterPack.
   * Updates the target character instance's active pack pointer atomically.
   */
  async activateDraft(params: {
    readonly characterId: string;
    readonly draftId: string;
    readonly userId?: string | undefined;
    readonly instanceId?: string | undefined;
    readonly packVersion?: string | undefined;
  }): Promise<CharacterPack> {
    const characterId = (params.characterId || '').trim();
    const userId = (params.userId || 'default-user').trim();
    const instanceId = (params.instanceId || 'default-instance').trim();

    const draft = this.getDraft(params.draftId);
    if (!draft) {
      throw new CharacterPackError('not_found', `未找到草稿: "${params.draftId}"`);
    }

    if (draft.characterId !== characterId) {
      throw new CharacterPackError(
        'invalid_request',
        `草稿所属角色 ("${draft.characterId}") 与请求角色 ("${characterId}") 不一致。`,
      );
    }

    if (!draft.validation.valid || draft.status !== 'validated') {
      throw new CharacterPackError(
        'validation_failed',
        `草稿尚未通过校验（status: ${draft.status}），不能激活为活动角色包。错误: ${draft.validation.errors.join('; ')}`,
      );
    }

    // Check revoked sources
    for (const srcId of draft.sourceIds) {
      if (this.isSourceRevoked(characterId, srcId)) {
        throw new CharacterPackError(
          'validation_failed',
          `草稿依赖的来源 "${srcId}" 已被撤销，无法激活。`,
        );
      }
    }

    // Determine version
    let version = (params.packVersion || '').trim();
    if (!version) {
      const count = (
        this.db
          .prepare('SELECT COUNT(*) as c FROM character_packs WHERE character_id=?')
          .get(characterId) as { c: number }
      ).c;
      version = `v${count + 1}.0`;
    }

    // Check if pack version already exists
    const existingPack = this.getPackByVersion(characterId, version);
    if (existingPack) {
      throw new CharacterPackError(
        'version_conflict',
        `角色包版本 "${version}" 已存在，不可变版本不可覆盖。`,
      );
    }

    const sourceHashes: string[] = [];
    for (const srcId of draft.sourceIds) {
      const src = this.getSource(srcId);
      if (src) sourceHashes.push(src.contentHash);
    }

    const canonTimeline = this.deriveCanonTimeline(draft.payload);
    const packId = `pack-${randomUUID()}`;
    const now = new Date().toISOString();

    let createdPack: CharacterPack;

    this.db.transaction(() => {
      // 1. Insert immutable pack
      this.db
        .prepare(
          `INSERT INTO character_packs
           (id, character_id, pack_version, schema_version, name, soul, style_hints_json,
            canon_facts_json, canon_timeline_json, gaps_json, source_ids_json, source_hashes_json,
            cutoff_point, work_title, draft_id, activated_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          packId,
          characterId,
          version,
          draft.schemaVersion,
          draft.payload.character.name,
          draft.payload.character.soul,
          draft.payload.character.styleHints ? JSON.stringify(draft.payload.character.styleHints) : null,
          JSON.stringify(draft.payload.canonFacts),
          JSON.stringify(canonTimeline),
          JSON.stringify(draft.payload.gaps),
          JSON.stringify(draft.sourceIds),
          JSON.stringify(sourceHashes),
          draft.payload.cutoffPoint ?? null,
          draft.payload.workTitle ?? null,
          draft.id,
          now,
          now,
        );

      // 2. Query existing instance
      const instanceRow = this.db
        .prepare('SELECT * FROM character_instances WHERE user_id=? AND character_id=? AND instance_id=?')
        .get(userId, characterId, instanceId) as InstanceRow | undefined;

      const previousPackId = instanceRow?.active_pack_id ?? null;
      const action = previousPackId ? 'upgrade' : 'activate';

      // 3. Upsert instance pointer
      this.db
        .prepare(
          `INSERT INTO character_instances
           (instance_id, user_id, character_id, active_pack_id, active_pack_version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(user_id, character_id, instance_id) DO UPDATE SET
             active_pack_id=excluded.active_pack_id,
             active_pack_version=excluded.active_pack_version,
             updated_at=excluded.updated_at`,
        )
        .run(instanceId, userId, characterId, packId, version, instanceRow?.created_at ?? now, now);

      // 4. Record history
      this.db
        .prepare(
          `INSERT INTO character_pack_history
           (id, user_id, character_id, instance_id, action, from_pack_id, to_pack_id, reason, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          `cph-${randomUUID()}`,
          userId,
          characterId,
          instanceId,
          action,
          previousPackId,
          packId,
          action === 'upgrade' ? `Upgraded from draft ${draft.id}` : `Initial activation from draft ${draft.id}`,
          now,
        );
    }).immediate();

    createdPack = this.getPack(packId)!;
    return createdPack;
  }

  /**
   * Rolls back an instance to a previously activated character pack version.
   * Strictly enforces: rollback cannot bypass source revocation.
   */
  async rollback(params: {
    readonly characterId: string;
    readonly targetPackVersion: string;
    readonly userId?: string | undefined;
    readonly instanceId?: string | undefined;
    readonly reason?: string | undefined;
  }): Promise<CharacterPack> {
    const characterId = (params.characterId || '').trim();
    const userId = (params.userId || 'default-user').trim();
    const instanceId = (params.instanceId || 'default-instance').trim();
    const targetVersion = (params.targetPackVersion || '').trim();

    const instanceRow = this.db
      .prepare('SELECT * FROM character_instances WHERE user_id=? AND character_id=? AND instance_id=?')
      .get(userId, characterId, instanceId) as InstanceRow | undefined;

    if (!instanceRow) {
      throw new CharacterPackError(
        'not_found',
        `未找到角色实例 (user: "${userId}", char: "${characterId}", instance: "${instanceId}")。`,
      );
    }

    const targetPack = this.getPackByVersion(characterId, targetVersion);
    if (!targetPack) {
      throw new CharacterPackError(
        'not_found',
        `未找到目标角色包版本 "${targetVersion}"。`,
      );
    }

    // IRON RULE: Rollback cannot bypass source revocation
    for (const srcId of targetPack.sourceIds) {
      if (this.isSourceRevoked(characterId, srcId)) {
        throw new CharacterPackError(
          'version_conflict',
          `回退失败：目标版本引用的来源 "${srcId}" 已被撤销；回退旧 pack 不能绕过来源撤销。`,
        );
      }
    }

    const previousPackId = instanceRow.active_pack_id;
    const now = new Date().toISOString();

    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE character_instances 
           SET active_pack_id=?, active_pack_version=?, updated_at=?
           WHERE user_id=? AND character_id=? AND instance_id=?`,
        )
        .run(targetPack.id, targetPack.packVersion, now, userId, characterId, instanceId);

      this.db
        .prepare(
          `INSERT INTO character_pack_history
           (id, user_id, character_id, instance_id, action, from_pack_id, to_pack_id, reason, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          `cph-${randomUUID()}`,
          userId,
          characterId,
          instanceId,
          'rollback',
          previousPackId,
          targetPack.id,
          params.reason || `Rollback to version ${targetVersion}`,
          now,
        );
    }).immediate();

    return targetPack;
  }

  getPack(packId: string): CharacterPack | null {
    const row = this.db
      .prepare('SELECT * FROM character_packs WHERE id=?')
      .get(packId) as PackRow | undefined;

    return row ? this.hydratePack(row) : null;
  }

  getPackByVersion(characterId: string, packVersion: string): CharacterPack | null {
    const row = this.db
      .prepare('SELECT * FROM character_packs WHERE character_id=? AND pack_version=?')
      .get(characterId, packVersion) as PackRow | undefined;

    return row ? this.hydratePack(row) : null;
  }

  listPacks(characterId: string): readonly CharacterPack[] {
    const rows = this.db
      .prepare('SELECT * FROM character_packs WHERE character_id=? ORDER BY created_at DESC')
      .all(characterId) as PackRow[];

    return Object.freeze(rows.map(r => this.hydratePack(r)));
  }

  getInstance(userId: string, characterId: string, instanceId: string): CharacterInstance | null {
    const row = this.db
      .prepare('SELECT * FROM character_instances WHERE user_id=? AND character_id=? AND instance_id=?')
      .get(userId, characterId, instanceId) as InstanceRow | undefined;

    if (!row) return null;

    return Object.freeze({
      instanceId: row.instance_id,
      userId: row.user_id,
      characterId: row.character_id,
      activePackId: row.active_pack_id,
      activePackVersion: row.active_pack_version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }

  // --- Source Revocation -----------------------------------------------------

  revokeSource(characterId: string, sourceId: string, reason?: string): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO character_source_revocations
         (id, character_id, target_type, target_id, reason, revoked_at)
         VALUES (?, ?, 'source', ?, ?, ?)`,
      )
      .run(
        `csr-${randomUUID()}`,
        characterId,
        sourceId,
        reason ?? null,
        new Date().toISOString(),
      );
  }

  isSourceRevoked(characterId: string, sourceId: string): boolean {
    const row = this.db
      .prepare(
        "SELECT id FROM character_source_revocations WHERE character_id=? AND target_type='source' AND target_id=?",
      )
      .get(characterId, sourceId);
    return row !== undefined;
  }

  // --- Companion Timeline ----------------------------------------------------

  appendCompanionEvent(event: {
    readonly userId: string;
    readonly characterId: string;
    readonly characterInstanceId: string;
    readonly sessionId: string;
    readonly turnId: string;
    readonly userText: string;
    readonly assistantText: string;
    readonly createdAt?: string | undefined;
    readonly sourceIds?: readonly string[] | undefined;
  }): CompanionTimelineEvent {
    const eventId = `cte-${randomUUID()}`;
    const createdAt = event.createdAt || new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO character_companion_timeline
         (event_id, user_id, character_id, character_instance_id, session_id, turn_id, user_text, assistant_text, created_at, source_ids_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        eventId,
        event.userId,
        event.characterId,
        event.characterInstanceId,
        event.sessionId,
        event.turnId,
        event.userText,
        event.assistantText,
        createdAt,
        JSON.stringify([...new Set(event.sourceIds ?? [])]),
      );

    return Object.freeze({
      eventId,
      userId: event.userId,
      characterId: event.characterId,
      characterInstanceId: event.characterInstanceId,
      sessionId: event.sessionId,
      turnId: event.turnId,
      userText: event.userText,
      assistantText: event.assistantText,
      createdAt,
      ...(event.sourceIds && event.sourceIds.length > 0 ? { sourceIds: Object.freeze([...new Set(event.sourceIds)]) } : {}),
    });
  }

  // --- ContinuityReadPort Implementation -------------------------------------

  async getSnapshot(
    pairing: PairingScope,
    options?: {
      readonly cutoffPoint?: string | undefined;
      readonly maxCanonEvents?: number | undefined;
      readonly maxCompanionEvents?: number | undefined;
      readonly awarenessFilter?: readonly CanonAwareness[] | undefined;
    },
  ): Promise<ContinuitySnapshot> {
    const instance = this.getInstance(pairing.userId, pairing.characterId, pairing.characterInstanceId);
    let activePack: CharacterPack | null = null;
    let canonTimeline: CanonTimelineEvent[] = [];

    if (instance?.activePackId) {
      activePack = this.getPack(instance.activePackId);
      if (activePack) {
        // Filter out events citing revoked sources
        let events = activePack.canonTimeline.filter(event => {
          return !event.evidenceIds.some(evId => {
            const srcId = evId.split(':')[0]!;
            return this.isSourceRevoked(pairing.characterId, srcId);
          });
        });

        // Filter by cutoffPoint if provided
        const effectiveCutoff = options?.cutoffPoint ?? activePack.cutoffPoint;
        if (effectiveCutoff) {
          // Find source snapshots to compute cutoff block boundaries
          const sources = this.listSources(pairing.characterId);
          const allowedBlockIds = computeCutoffAllowedBlockIds(sources, effectiveCutoff);
          events = events.filter(e => e.evidenceIds.every(id => allowedBlockIds.has(id)));
        }

        // Filter by awareness if provided
        if (options?.awarenessFilter && options.awarenessFilter.length > 0) {
          const filterSet = new Set(options.awarenessFilter);
          events = events.filter(e => filterSet.has(e.awareness));
        }

        // Sort by ordinal
        events.sort((a, b) => a.ordinal - b.ordinal);

        // Limit
        const maxCanon = options?.maxCanonEvents ?? 50;
        canonTimeline = events.slice(0, maxCanon);
      }
    }

    // Retrieve companion timeline events (strictly scoped to pairing!)
    const maxCompanion = options?.maxCompanionEvents ?? 50;
    const companionRows = this.db
      .prepare(
        `SELECT * FROM character_companion_timeline
         WHERE user_id=? AND character_id=? AND character_instance_id=?
         ORDER BY created_at ASC
         LIMIT ?`,
      )
      .all(pairing.userId, pairing.characterId, pairing.characterInstanceId, maxCompanion * 2) as CompanionEventRow[];

    const companionTimeline: CompanionTimelineEvent[] = companionRows.filter(r => {
      const sourceIds = r.source_ids_json ? JSON.parse(r.source_ids_json) as string[] : [];
      return sourceIds.every(id => !this.isContinuityFactRevoked(pairing, id));
    }).slice(0, maxCompanion).map(r => {
      const sourceIds = r.source_ids_json ? JSON.parse(r.source_ids_json) as string[] : [];
      return Object.freeze({
        eventId: r.event_id,
        userId: r.user_id,
        characterId: r.character_id,
        characterInstanceId: r.character_instance_id,
        sessionId: r.session_id,
        turnId: r.turn_id,
        userText: r.user_text,
        assistantText: r.assistant_text,
        createdAt: r.created_at,
        ...(sourceIds.length > 0 ? { sourceIds: Object.freeze(sourceIds) } : {}),
      });
    });

    // Calculate revision number
    const packCount = (
      this.db
        .prepare('SELECT COUNT(*) as c FROM character_packs WHERE character_id=?')
        .get(pairing.characterId) as { c: number }
    ).c;
    const historyCount = (
      this.db
        .prepare('SELECT COUNT(*) as c FROM character_pack_history WHERE character_id=?')
        .get(pairing.characterId) as { c: number }
    ).c;
    const companionCount = (
      this.db
        .prepare(
          'SELECT COUNT(*) as c FROM character_companion_timeline WHERE user_id=? AND character_id=? AND character_instance_id=?',
        )
        .get(pairing.userId, pairing.characterId, pairing.characterInstanceId) as { c: number }
    ).c;
    const revocationCount = (
      this.db
        .prepare('SELECT COUNT(*) as c FROM character_source_revocations WHERE character_id=?')
        .get(pairing.characterId) as { c: number }
    ).c;

    const packRevision = packCount + historyCount + companionCount + revocationCount + 1;

    return Object.freeze({
      pairing: Object.freeze({ ...pairing }),
      activePack,
      canonTimeline: Object.freeze(canonTimeline),
      companionTimeline: Object.freeze(companionTimeline),
      packRevision,
    });
  }

  // --- Internal Helpers ------------------------------------------------------

  private hydratePack(row: PackRow): CharacterPack {
    return Object.freeze({
      id: row.id,
      characterId: row.character_id,
      packVersion: row.pack_version,
      schemaVersion: row.schema_version,
      name: row.name,
      soul: row.soul,
      styleHints: row.style_hints_json ? Object.freeze(JSON.parse(row.style_hints_json)) : undefined,
      canonFacts: Object.freeze(JSON.parse(row.canon_facts_json)),
      canonTimeline: Object.freeze(JSON.parse(row.canon_timeline_json)),
      gaps: Object.freeze(JSON.parse(row.gaps_json)),
      sourceIds: Object.freeze(JSON.parse(row.source_ids_json)),
      sourceHashes: Object.freeze(JSON.parse(row.source_hashes_json)),
      cutoffPoint: row.cutoff_point ?? undefined,
      workTitle: row.work_title ?? undefined,
      draftId: row.draft_id ?? undefined,
      activatedAt: row.activated_at ?? undefined,
      createdAt: row.created_at,
    });
  }

  private isContinuityFactRevoked(pairing: PairingScope, factId: string): boolean {
    try {
      const row = this.db.prepare('SELECT 1 AS found FROM continuity_tombstones WHERE user_id=? AND character_id=? AND instance_id=? AND fact_id=? LIMIT 1')
        .get(pairing.userId, pairing.characterId, pairing.characterInstanceId, factId) as { found: number } | undefined;
      return Boolean(row);
    } catch { return false; }
  }

  private deriveCanonTimeline(payload: CharacterPackDraftPayload): readonly CanonTimelineEvent[] {
    return payload.canonFacts.map((fact, index) =>
      Object.freeze({
        eventId: `ce-${fact.id}`,
        ordinal: index,
        summary: fact.text,
        charactersInvolved: Object.freeze([payload.character.name]),
        awareness: 'experienced' as CanonAwareness,
        evidenceIds: fact.evidenceIds,
        status: fact.status ?? 'explicit',
      }),
    );
  }
}

// Backward compatibility alias for N07-01 callers
export { CharacterPackStore as CharacterPackDraftStore };
