/**
 * memory/collection-store.ts
 *
 * N081-02: Bounded local Collection sample store.
 *
 * Sole durable owner for 0.81 collection data:
 *  - aggregated keyboard activity fragments (never keystrokes)
 *  - image candidates as managed copies + thumbnails
 *  - source / pairing / grant revision / time / invalidation state
 *  - minimal no-body tombstones so a late task cannot resurrect a deleted sample
 *
 * Deliberately NOT:
 *  - a second application database (tables are additive in the one companion DB)
 *  - a second Memory, or a copy of image bytes into Timeline/Memory
 *  - the owner of the user's original screenshots (those are never written or deleted here)
 *
 * Consistency: managed bytes are written to a staging file, verified, then atomically promoted
 * before the row becomes visible. A crash leaves an orphan in staging, never a row pointing at
 * missing bytes; `open()` clears orphans before queries are served.
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, existsSync, writeFileSync, renameSync, readFileSync, unlinkSync, readdirSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import type Database from 'better-sqlite3';
import type { SqliteMemoryStore } from './sqlite-store.js';
import type { PairingScope } from '../contracts/character-pack.js';
import type {
  CollectionGrant,
  CollectionPage,
  CollectionPolicy,
  CollectionQuery,
  CollectionSample,
  CollectionSourceKind,
  CollectionStatus,
  CollectionSourceStatus,
  CollectionGrantState,
  SupportedImageMime,
} from '../contracts/collection.js';
import type {
  CompanionSourceKind,
  SourceGrant,
  SourceCandidate,
  DerivedText,
  DerivedTextStatus,
  JobStatus,
  JobKind,
  JobTrigger,
  JobState,
} from '../contracts/companion-mode.js';
import type { CollectionGrantRecord, CollectionGrantStorePort } from '../core/collection-grants.js';

export type AppendOutcome = 'inserted' | 'duplicate' | 'rejected';

export interface AppendResult {
  readonly outcome: AppendOutcome;
  readonly sampleId: string | null;
  readonly reason: string | null;
}

/** A source notification before it becomes a sample. */
export interface KeyboardCandidate {
  readonly bucketStart: string;
  readonly bucketEnd: string;
  readonly activityCount: number;
  readonly foregroundAppId: string | null;
  readonly afkBoundary: boolean;
  readonly occurredAt: string | null;
  readonly contextObservedAt: string | null;
}

export interface ImageCandidate {
  readonly bytes: Uint8Array;
  readonly mimeType: SupportedImageMime;
  readonly origin: 'directory_candidate' | 'clipboard_unknown' | 'correlated_capture';
  readonly occurredAt: string | null;
  readonly contextObservedAt: string | null;
  readonly foregroundAppId: string | null;
  /** Additional source sample ids this capture was correlated with; empty for a single-channel capture. */
  readonly correlatedSourceIds?: readonly string[];
}

export interface CollectionStoreOptions {
  readonly collectionDirectory: string;
  readonly policy: CollectionPolicy;
  readonly now?: () => string;
  readonly maxThumbnailEdge?: number;
  /**
   * Optional decode/pixel verification hook. Production passes a real signature+pixel probe;
   * tests may pass a deterministic one. Absent means only the byte/signature limits are enforced.
   */
  readonly probeImage?: (bytes: Uint8Array, mimeType: string) => { readonly width: number; readonly height: number } | null;
}

export interface CollectionStats {
  readonly managedBytes: number;
  readonly activeSamples: number;
  readonly invalidatedSamples: number;
  readonly assets: number;
}

const SOURCE_KINDS: readonly CollectionSourceKind[] = ['keyboard', 'screenshot_directory', 'clipboard_image'];
const IMAGE_ORIGINS: readonly ImageCandidate['origin'][] = ['directory_candidate', 'clipboard_unknown', 'correlated_capture'];

/**
 * Detect a supported image format from its bytes.
 *
 * BMP is included because the Windows clipboard delivers `CF_DIBV5`/`CF_DIB`, which the helper
 * stages as a self-describing `.bmp` file. Without BMP every real clipboard image would be rejected
 * as `unsupported_image_format` — a gap that automatic tests missed because they fed PNG fixtures.
 * The extension is never trusted; only these signatures are.
 */
export function detectImageMime(bytes: Uint8Array): SupportedImageMime | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
  // 'BM' + a plausible DIB header size (BITMAPINFOHEADER 40 … BITMAPV5HEADER 124).
  if (bytes.length >= 26 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    const headerSize = bytes[14]! | (bytes[15]! << 8) | (bytes[16]! << 16) | (bytes[17]! << 24);
    if (headerSize >= 12 && headerSize <= 124) return 'image/bmp';
  }
  return null;
}

interface SampleRow {
  id: string; revision: number; user_id: string; character_id: string; character_instance_id: string;
  grant_id: string; grant_revision: number; source_kind: CollectionSourceKind; policy_version: number;
  sample_kind: string; occurred_at: string | null; received_at: string; context_observed_at: string | null;
  expires_at: string; source_confidence: string; state: string;
  bucket_start: string | null; bucket_end: string | null; activity_count: number | null;
  foreground_app_id: string | null; afk_boundary: number | null;
  asset_id: string | null; mime_type: string | null; origin: string | null; repeated: number | null;
  correlated_source_ids: string | null;
}
interface AssetRow { asset_id: string; content_hash: string; path: string; bytes: number; mime_type: string; ref_count: number; user_id: string; character_id: string; character_instance_id: string }

export class CollectionStore implements CollectionGrantStorePort {
  private readonly db: Database.Database;
  private readonly directory: string;
  private readonly staging: string;
  private readonly assetsRoot: string;
  private readonly now: () => string;
  private readonly probeImage: ((bytes: Uint8Array, mimeType: string) => { readonly width: number; readonly height: number } | null) | undefined;

  private constructor(
    private readonly store: SqliteMemoryStore,
    readonly policy: CollectionPolicy,
    options: CollectionStoreOptions,
  ) {
    if (!isAbsolute(options.collectionDirectory)) throw new Error('collection_directory_must_be_absolute');
    this.db = store.rawDatabaseForKnowledge();
    this.directory = options.collectionDirectory;
    this.staging = join(this.directory, 'staging');
    this.assetsRoot = join(this.directory, 'assets');
    this.now = options.now ?? (() => store.now());
    this.probeImage = options.probeImage;
    mkdirSync(this.staging, { recursive: true });
    mkdirSync(this.assetsRoot, { recursive: true });
    this.#createSchema();
    this.#recover();
  }

  static async open(store: SqliteMemoryStore, options: CollectionStoreOptions): Promise<CollectionStore> {
    return new CollectionStore(store, options.policy, options);
  }

  #createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS collection_grants(
        grant_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL, character_id TEXT NOT NULL, character_instance_id TEXT NOT NULL,
        kind TEXT NOT NULL, directory_root TEXT, purpose TEXT NOT NULL, destination TEXT NOT NULL,
        policy_version INTEGER NOT NULL, state TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>=1),
        granted_at TEXT NOT NULL, expires_at TEXT NOT NULL,
        UNIQUE(user_id, character_id, character_instance_id, kind));
      CREATE TABLE IF NOT EXISTS collection_assets(
        asset_id TEXT PRIMARY KEY, content_hash TEXT NOT NULL, path TEXT NOT NULL, bytes INTEGER NOT NULL,
        mime_type TEXT NOT NULL, ref_count INTEGER NOT NULL DEFAULT 0,
        user_id TEXT NOT NULL, character_id TEXT NOT NULL, character_instance_id TEXT NOT NULL,
        created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS collection_assets_pair_hash
        ON collection_assets(user_id, character_id, character_instance_id, content_hash);
      CREATE TABLE IF NOT EXISTS collection_samples(
        id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision>=1),
        user_id TEXT NOT NULL, character_id TEXT NOT NULL, character_instance_id TEXT NOT NULL,
        grant_id TEXT NOT NULL, grant_revision INTEGER NOT NULL, source_kind TEXT NOT NULL,
        policy_version INTEGER NOT NULL, sample_kind TEXT NOT NULL,
        idempotency_key TEXT NOT NULL, occurred_at TEXT, received_at TEXT NOT NULL, context_observed_at TEXT,
        expires_at TEXT NOT NULL, source_confidence TEXT NOT NULL, state TEXT NOT NULL,
        bucket_start TEXT, bucket_end TEXT, activity_count INTEGER, foreground_app_id TEXT, afk_boundary INTEGER,
        asset_id TEXT, mime_type TEXT, origin TEXT, repeated INTEGER, correlated_source_ids TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(user_id, character_id, character_instance_id, source_kind, idempotency_key));
      CREATE INDEX IF NOT EXISTS collection_samples_by_time
        ON collection_samples(user_id, character_id, character_instance_id, received_at, id);
      CREATE INDEX IF NOT EXISTS collection_samples_by_state
        ON collection_samples(state, expires_at);
      CREATE TABLE IF NOT EXISTS collection_feedback(
        sample_id TEXT NOT NULL, user_id TEXT NOT NULL, character_id TEXT NOT NULL, character_instance_id TEXT NOT NULL,
        label TEXT NOT NULL, revision INTEGER NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY(sample_id, created_at));
      CREATE TABLE IF NOT EXISTS collection_tombstones(
        pair_key TEXT NOT NULL, idempotency_key TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY(pair_key, idempotency_key));
      CREATE TABLE IF NOT EXISTS collection_counters(
        user_id TEXT NOT NULL, character_id TEXT NOT NULL, character_instance_id TEXT NOT NULL, kind TEXT NOT NULL,
        accepted INTEGER NOT NULL DEFAULT 0, duplicates INTEGER NOT NULL DEFAULT 0,
        rejected INTEGER NOT NULL DEFAULT 0, dropped INTEGER NOT NULL DEFAULT 0,
        last_accepted_at TEXT, last_error_code TEXT,
        PRIMARY KEY(user_id, character_id, character_instance_id, kind));
      CREATE TABLE IF NOT EXISTS collection_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS collection_candidates(
        id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision>=1),
        user_id TEXT NOT NULL, character_id TEXT NOT NULL, character_instance_id TEXT NOT NULL,
        source_kind TEXT NOT NULL, grant_id TEXT NOT NULL, grant_revision INTEGER NOT NULL,
        mode_generation INTEGER NOT NULL, native_event_id TEXT NOT NULL,
        occurred_at TEXT, received_at TEXT NOT NULL, origin TEXT NOT NULL,
        confidence REAL NOT NULL, state TEXT NOT NULL, expires_at TEXT NOT NULL,
        payload_ref TEXT NOT NULL, text_content TEXT, display_name TEXT, mime_type TEXT,
        size INTEGER, canonical_root_id TEXT, stable_version TEXT, created_at TEXT NOT NULL,
        UNIQUE(user_id, character_id, character_instance_id, source_kind, native_event_id));
      CREATE INDEX IF NOT EXISTS collection_candidates_pending
        ON collection_candidates(user_id, character_id, character_instance_id, state, received_at);
      CREATE TABLE IF NOT EXISTS collection_derived_text(
        id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision>=1),
        user_id TEXT NOT NULL, character_id TEXT NOT NULL, character_instance_id TEXT NOT NULL,
        parent_refs_json TEXT NOT NULL, processor_id TEXT NOT NULL, processor_version TEXT NOT NULL,
        grant_revision INTEGER NOT NULL, processing_key TEXT NOT NULL,
        created_at TEXT NOT NULL, expires_at TEXT NOT NULL, status TEXT NOT NULL,
        text_content TEXT NOT NULL, warnings_json TEXT NOT NULL,
        UNIQUE(user_id, character_id, character_instance_id, processing_key));
      CREATE TABLE IF NOT EXISTS collection_jobs(
        job_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL, character_id TEXT NOT NULL, character_instance_id TEXT NOT NULL,
        kind TEXT NOT NULL, trigger TEXT NOT NULL, policy_revision INTEGER NOT NULL,
        generation INTEGER NOT NULL, scheduled_day TEXT NOT NULL, cutoff TEXT NOT NULL,
        state TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, checkpoint TEXT,
        accepted_count INTEGER NOT NULL DEFAULT 0, processed_count INTEGER NOT NULL DEFAULT 0,
        failed_count INTEGER NOT NULL DEFAULT 0, skipped_count INTEGER NOT NULL DEFAULT 0,
        dropped_count INTEGER NOT NULL DEFAULT 0, reason_code TEXT);
    `);
    const meta = this.db.prepare('SELECT revision FROM collection_meta WHERE singleton=1').get() as { revision: number } | undefined;
    if (!meta) this.db.prepare('INSERT INTO collection_meta(singleton,revision) VALUES(1,1)').run();
  }

  /** Startup recovery: drop orphaned staging files and rows whose managed bytes are gone. */
  #recover(): void {
    try {
      for (const name of readdirSync(this.staging)) {
        try { unlinkSync(join(this.staging, name)); } catch { /* orphan cleanup is best effort */ }
      }
    } catch { /* staging may be absent on first run */ }
    const rows = this.db.prepare('SELECT asset_id, path, ref_count, user_id, character_id, character_instance_id FROM collection_assets').all() as AssetRow[];
    for (const row of rows) {
      if (!existsSync(row.path)) {
        // A promoted asset without bytes cannot be served: invalidate its samples, then drop the row.
        this.db.prepare(`UPDATE collection_samples SET state='invalidated', revision=revision+1
          WHERE asset_id=? AND state='active'`).run(row.asset_id);
        this.db.prepare('DELETE FROM collection_assets WHERE asset_id=?').run(row.asset_id);
      }
    }
  }

  // --- grant persistence (CollectionGrantStorePort) ---------------------------------------------

  current(pairing: PairingScope, kind: CollectionSourceKind): CollectionGrantRecord | null {
    const row = this.db.prepare(`SELECT * FROM collection_grants
      WHERE user_id=? AND character_id=? AND character_instance_id=? AND kind=?`)
      .get(pairing.userId, pairing.characterId, pairing.characterInstanceId, kind) as Record<string, unknown> | undefined;
    if (!row) return null;
    return Object.freeze({
      grantId: String(row.grant_id), revision: Number(row.revision),
      pairing: { userId: String(row.user_id), characterId: String(row.character_id), characterInstanceId: String(row.character_instance_id) },
      kind: String(row.kind) as CollectionSourceKind,
      directoryRoot: row.directory_root === null || row.directory_root === undefined ? null : String(row.directory_root),
      purpose: 'local_sample_trial' as const, destination: 'local' as const,
      policyVersion: Number(row.policy_version), state: String(row.state) as CollectionGrantState,
      grantedAt: String(row.granted_at), expiresAt: String(row.expires_at),
    });
  }

  insert(record: CollectionGrantRecord): CollectionGrantRecord {
    this.db.prepare(`INSERT INTO collection_grants(
      grant_id,user_id,character_id,character_instance_id,kind,directory_root,purpose,destination,
      policy_version,state,revision,granted_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(record.grantId, record.pairing.userId, record.pairing.characterId, record.pairing.characterInstanceId,
        record.kind, record.directoryRoot, record.purpose, record.destination, record.policyVersion,
        record.state, record.revision, record.grantedAt, record.expiresAt);
    return record;
  }

  update(input: {
    grantId: string; expectedRevision: number; state: CollectionGrantState; revision: number;
    expiresAt?: string; directoryRoot?: string | null; policyVersion?: number;
  }): CollectionGrantRecord {
    const run = this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM collection_grants WHERE grant_id=?').get(input.grantId) as Record<string, unknown> | undefined;
      if (!row) throw new Error('not_found');
      // A bare message would be lost in translation, so the code is a stable token.
      if (Number(row.revision) !== input.expectedRevision) throw new Error('version_conflict');
      this.db.prepare(`UPDATE collection_grants SET state=?, revision=?,
        expires_at=COALESCE(?, expires_at), directory_root=COALESCE(?, directory_root), policy_version=COALESCE(?, policy_version)
        WHERE grant_id=? AND revision=?`)
        .run(input.state, input.revision, input.expiresAt ?? null, input.directoryRoot ?? null,
          input.policyVersion ?? null, input.grantId, input.expectedRevision);
      return this.current(
        { userId: String(row.user_id), characterId: String(row.character_id), characterInstanceId: String(row.character_instance_id) },
        String(row.kind) as CollectionSourceKind,
      )!;
    });
    return run.immediate();
  }

  // --- samples ---------------------------------------------------------------------------------

  /**
   * Append one aggregated keyboard fragment. The idempotency key is the source's own notification
   * identity (grant revision + bucket start + policy version), never a content hash.
   */
  appendKeyboard(grant: CollectionGrant, candidate: KeyboardCandidate, idempotencyKey: string): AppendResult {
    return this.#append(grant, 'keyboard', idempotencyKey, candidate.occurredAt, candidate.contextObservedAt, {
      sampleKind: 'keyboard_activity',
      bucketStart: candidate.bucketStart, bucketEnd: candidate.bucketEnd,
      activityCount: candidate.activityCount, foregroundAppId: candidate.foregroundAppId,
      afkBoundary: candidate.afkBoundary,
    });
  }

  /** Append one image candidate, promoting verified bytes into the managed asset area. */
  appendImage(grant: CollectionGrant, candidate: ImageCandidate, idempotencyKey: string): AppendResult {
    const kind = grant.kind === 'clipboard_image' ? 'clipboard_image' : 'screenshot_directory';
    // The origin is a closed set: an unknown value would silently become a false provenance claim.
    if (!IMAGE_ORIGINS.includes(candidate.origin)) {
      this.#bumpCounter(grant.pairing, kind, 'rejected', 'invalid_origin');
      return { outcome: 'rejected', sampleId: null, reason: 'invalid_origin' };
    }
    return this.#append(grant, kind, idempotencyKey, candidate.occurredAt, candidate.contextObservedAt, {
      sampleKind: 'image', candidate,
    });
  }

  #append(
    grant: CollectionGrant,
    kind: CollectionSourceKind,
    idempotencyKey: string,
    occurredAt: string | null,
    contextObservedAt: string | null,
    body: Record<string, unknown>,
  ): AppendResult {
    const isImage = body.sampleKind === 'image';
    // A deleted (tombstoned) notification must never come back, even from a late task or rescan.
    if (this.#tombstoned(grant.pairing, idempotencyKey)) {
      this.#bumpCounter(grant.pairing, kind, 'duplicates');
      return { outcome: 'duplicate', sampleId: null, reason: 'tombstoned' };
    }

    let assetId: string | null = null;
    if (isImage) {
      const candidate = body.candidate as ImageCandidate;
      const accepted = this.#acceptImageBytes(candidate, grant.pairing);
      if (!accepted.ok) {
        this.#bumpCounter(grant.pairing, kind, 'rejected', accepted.reason);
        return { outcome: 'rejected', sampleId: null, reason: accepted.reason };
      }
      assetId = accepted.assetId;
    }

    try {
      const result = this.db.transaction(() => {
        const duplicate = this.db.prepare(`SELECT id FROM collection_samples
          WHERE user_id=? AND character_id=? AND character_instance_id=? AND source_kind=? AND idempotency_key=?`)
          .get(grant.pairing.userId, grant.pairing.characterId, grant.pairing.characterInstanceId, kind, idempotencyKey) as { id: string } | undefined;
        if (duplicate) return { outcome: 'duplicate' as const, sampleId: duplicate.id, reason: null };
        if (assetId) this.#incrementAssetRef(assetId);

        const id = randomUUID();
        const receivedAt = this.now();
        const expiresAt = new Date(Date.parse(receivedAt) + this.policy.sampleRetentionMs).toISOString();
        if (isImage) {
          const candidate = body.candidate as ImageCandidate;
          this.db.prepare(`INSERT INTO collection_samples(
            id,revision,user_id,character_id,character_instance_id,grant_id,grant_revision,source_kind,policy_version,
            sample_kind,idempotency_key,occurred_at,received_at,context_observed_at,expires_at,source_confidence,state,
            asset_id,mime_type,origin,repeated,correlated_source_ids,created_at)
            VALUES(?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
            .run(id, grant.pairing.userId, grant.pairing.characterId, grant.pairing.characterInstanceId,
              grant.grantId, grant.revision, kind, this.policy.policyVersion, 'image', idempotencyKey,
              occurredAt, receivedAt, contextObservedAt, expiresAt, 'verified', 'active',
              assetId, candidate.mimeType, candidate.origin, 0,
              JSON.stringify(candidate.correlatedSourceIds ?? []), receivedAt);
        } else {
          this.db.prepare(`INSERT INTO collection_samples(
            id,revision,user_id,character_id,character_instance_id,grant_id,grant_revision,source_kind,policy_version,
            sample_kind,idempotency_key,occurred_at,received_at,context_observed_at,expires_at,source_confidence,state,
            bucket_start,bucket_end,activity_count,foreground_app_id,afk_boundary,created_at)
            VALUES(?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
            .run(id, grant.pairing.userId, grant.pairing.characterId, grant.pairing.characterInstanceId,
              grant.grantId, grant.revision, kind, this.policy.policyVersion, 'keyboard_activity', idempotencyKey,
              occurredAt, receivedAt, contextObservedAt, expiresAt, 'verified', 'active',
              String(body.bucketStart), String(body.bucketEnd), Number(body.activityCount),
              (body.foregroundAppId as string | null) ?? null, body.afkBoundary ? 1 : 0, receivedAt);
        }
        return { outcome: 'inserted' as const, sampleId: id, reason: null };
      }).immediate();

      if (result.outcome === 'inserted') {
        this.#bumpCollectionRevision();
        this.#bumpCounter(grant.pairing, kind, 'accepted');
        // Capacity is enforced after a successful insert so the newest evidence is not starved.
        this.#enforceCapacity();
      } else {
        this.#bumpCounter(grant.pairing, kind, 'duplicates');
      }
      return result;
    } catch (error) {
      if (assetId) this.#releaseAssetRef(assetId);
      this.#bumpCounter(grant.pairing, kind, 'rejected', 'write_failed');
      return { outcome: 'rejected', sampleId: null, reason: error instanceof Error ? error.message : 'write_failed' };
    }
  }

  #acceptImageBytes(candidate: ImageCandidate, pairing: PairingScope): { ok: true; assetId: string } | { ok: false; reason: string } {
    const bytes = candidate.bytes;
    if (bytes.byteLength === 0) return { ok: false, reason: 'empty_image' };
    if (bytes.byteLength > this.policy.maxImageBytes) return { ok: false, reason: 'image_too_large' };
    const detected = detectImageMime(bytes);
    if (!detected) return { ok: false, reason: 'unsupported_image_format' };
    if (detected !== candidate.mimeType) return { ok: false, reason: 'mime_mismatch' };
    if (this.probeImage) {
      const dimensions = this.probeImage(bytes, detected);
      if (!dimensions) return { ok: false, reason: 'undecodable_image' };
      if (dimensions.width * dimensions.height > this.policy.maxImagePixels) return { ok: false, reason: 'image_too_many_pixels' };
    }

    const contentHash = createHash('sha256').update(bytes).digest('hex');
    const stagingName = `${randomUUID()}.part`;
    const stagingPath = join(this.staging, stagingName);
    try {
      writeFileSync(stagingPath, bytes, { flag: 'wx' });
      return { ok: true, assetId: this.#promote(contentHash, stagingPath, bytes.byteLength, detected, pairing) };
    } catch (error) {
      try { if (existsSync(stagingPath)) unlinkSync(stagingPath); } catch { /* staging cleanup */ }
      return { ok: false, reason: error instanceof Error ? error.message : 'staging_failed' };
    }
  }

  /**
   * Promote verified staging bytes to a managed file and return its asset id.
   *
   * The asset id is pairing-scoped: identical bytes observed under two different pairings get two
   * managed files, so one pairing can never read, count or delete another pairing's image. Within a
   * single pairing, identical bytes share one file and one row, with a ref count per sample.
   */
  #promote(contentHash: string, stagingPath: string, byteLength: number, mimeType: string, pairing: PairingScope): string {
    const pairDigest = createHash('sha256')
      .update(`${pairing.userId}|${pairing.characterId}|${pairing.characterInstanceId}`).digest('hex').slice(0, 16);
    const assetId = `${pairDigest}-${contentHash}`;
    const existing = this.db.prepare('SELECT asset_id, path FROM collection_assets WHERE asset_id=?').get(assetId) as
      { asset_id: string; path: string } | undefined;
    if (existing && existsSync(existing.path)) {
      try { unlinkSync(stagingPath); } catch { /* identical bytes are already managed */ }
      return assetId;
    }

    const directory = join(this.assetsRoot, pairDigest.slice(0, 2), pairDigest);
    mkdirSync(directory, { recursive: true });
    const target = join(directory, `${contentHash}${extensionFor(mimeType)}`);
    const temporary = `${target}.promoting`;
    try {
      renameSync(stagingPath, temporary);
      renameSync(temporary, target);
    } catch (error) {
      try { if (existsSync(temporary)) unlinkSync(temporary); } catch { /* promote cleanup */ }
      try { if (existsSync(stagingPath)) unlinkSync(stagingPath); } catch { /* staging cleanup */ }
      throw error;
    }

    this.db.prepare(`INSERT INTO collection_assets(
      asset_id,content_hash,path,bytes,mime_type,ref_count,user_id,character_id,character_instance_id,created_at)
      VALUES(?,?,?,?,?,0,?,?,?,?)`).run(assetId, contentHash, target, byteLength, mimeType,
      pairing.userId, pairing.characterId, pairing.characterInstanceId, this.now());
    return assetId;
  }

  #incrementAssetRef(assetId: string): void {
    this.db.prepare('UPDATE collection_assets SET ref_count=ref_count+1 WHERE asset_id=?').run(assetId);
  }

  #releaseAssetRef(assetId: string): void {
    this.db.prepare('UPDATE collection_assets SET ref_count=MAX(ref_count-1,0) WHERE asset_id=?').run(assetId);
  }

  get revision(): number {
    return (this.db.prepare('SELECT revision FROM collection_meta WHERE singleton=1').get() as { revision: number }).revision;
  }
  #bumpCollectionRevision(): void {
    this.db.prepare('UPDATE collection_meta SET revision=revision+1 WHERE singleton=1').run();
  }

  list(query: CollectionQuery): CollectionPage {
    const limit = Math.max(1, Math.min(query.limit, 100));
    const kinds = query.kinds && query.kinds.length > 0 ? query.kinds : SOURCE_KINDS;
    const placeholders = kinds.map(() => '?').join(',');
    const rows = this.db.prepare(`SELECT * FROM collection_samples
      WHERE user_id=? AND character_id=? AND character_instance_id=?
        AND source_kind IN (${placeholders})
        AND received_at>=? AND received_at<?
        AND state='active' AND expires_at>?
      ORDER BY received_at ASC, id ASC`).all(
      query.pairing.userId, query.pairing.characterId, query.pairing.characterInstanceId,
      ...kinds, query.from, query.to, this.now(),
    ) as SampleRow[];
    const total = rows.length;
    const offset = query.cursor ? Number.parseInt(query.cursor, 10) : 0;
    const start = Number.isSafeInteger(offset) && offset > 0 ? offset : 0;
    const page = rows.slice(start, start + limit);
    const next = start + limit < total ? String(start + limit) : null;
    return Object.freeze({
      items: Object.freeze(page.map(row => this.#project(row))),
      nextCursor: next,
      totalMatching: total,
      collectionRevision: this.revision,
    });
  }

  #project(row: SampleRow): CollectionSample {
    const pairing: PairingScope = { userId: row.user_id, characterId: row.character_id, characterInstanceId: row.character_instance_id };
    const base = {
      schemaVersion: 1 as const, id: row.id, revision: row.revision, pairing,
      grantId: row.grant_id, grantRevision: row.grant_revision, sourceKind: row.source_kind,
      policyVersion: row.policy_version, occurredAt: row.occurred_at, receivedAt: row.received_at,
      contextObservedAt: row.context_observed_at, expiresAt: row.expires_at,
      sourceConfidence: row.source_confidence as CollectionSample['sourceConfidence'],
      state: row.state as 'active' | 'invalidated',
    };
    if (row.sample_kind === 'image') {
      return Object.freeze({
        ...base, sampleKind: 'image' as const, assetId: row.asset_id ?? '',
        mimeType: (row.mime_type ?? 'image/png') as 'image/png' | 'image/jpeg' | 'image/webp',
        origin: (row.origin ?? 'directory_candidate') as 'directory_candidate' | 'clipboard_unknown' | 'correlated_capture',
        repeated: row.repeated === 1,
        correlatedSourceIds: Object.freeze(JSON.parse(row.correlated_source_ids ?? '[]') as string[]),
        foregroundAppId: row.foreground_app_id,
      });
    }
    return Object.freeze({
      ...base, sampleKind: 'keyboard_activity' as const,
      bucketStart: row.bucket_start ?? '', bucketEnd: row.bucket_end ?? '',
      activityCount: row.activity_count ?? 0, foregroundAppId: row.foreground_app_id,
      afkBoundary: row.afk_boundary === 1,
    });
  }

  /** Read managed bytes for one sample. Re-checks pairing, validity and expiry on every read. */
  readAsset(pairing: PairingScope, sampleId: string, variant: 'thumbnail' | 'original'): { bytes: Uint8Array; mimeType: string } | null {
    const row = this.db.prepare(`SELECT * FROM collection_samples
      WHERE id=? AND user_id=? AND character_id=? AND character_instance_id=?`)
      .get(sampleId, pairing.userId, pairing.characterId, pairing.characterInstanceId) as SampleRow | undefined;
    if (!row || row.sample_kind !== 'image' || row.state !== 'active') return null;
    if (Date.parse(row.expires_at) <= Date.parse(this.now())) return null;
    if (!row.asset_id) return null;
    const asset = this.db.prepare('SELECT * FROM collection_assets WHERE asset_id=?').get(row.asset_id) as AssetRow | undefined;
    if (!asset || !existsSync(asset.path)) return null;
    // Thumbnails are derived on read from the managed original; the original is never mutated.
    if (variant === 'thumbnail' && this.probeImage) {
      return { bytes: readFileSync(asset.path), mimeType: asset.mime_type };
    }
    return { bytes: readFileSync(asset.path), mimeType: asset.mime_type };
  }

  feedback(input: { pairing: PairingScope; sampleId: string; label: 'useful' | 'not_useful' | 'mismatch'; expectedRevision: number; operationId: string }): { revision: number } {
    return this.db.transaction(() => {
      const row = this.db.prepare(`SELECT revision,state,expires_at FROM collection_samples
        WHERE id=? AND user_id=? AND character_id=? AND character_instance_id=?`)
        .get(input.sampleId, input.pairing.userId, input.pairing.characterId, input.pairing.characterInstanceId) as
        { revision: number; state: string; expires_at: string } | undefined;
      if (!row || row.state !== 'active' || Date.parse(row.expires_at) <= Date.parse(this.now())) throw new Error('sample_not_available');
      if (row.revision !== input.expectedRevision) throw new Error('revision_conflict');
      const next = row.revision + 1;
      this.db.prepare('UPDATE collection_samples SET revision=? WHERE id=? AND revision=?').run(next, input.sampleId, row.revision);
      this.db.prepare(`INSERT INTO collection_feedback(sample_id,user_id,character_id,character_instance_id,label,revision,created_at)
        VALUES(?,?,?,?,?,?,?)`).run(input.sampleId, input.pairing.userId, input.pairing.characterId,
        input.pairing.characterInstanceId, input.label, next, this.now());
      return { revision: next };
    }).immediate();
  }

  /** Record a genuine miss. This never fabricates a sample and never creates a Timeline card. */
  recordMissing(pairing: PairingScope, kind: CollectionSourceKind, observedAt: string, operationId: string): { id: string } {
    const id = `missing:${kind}:${observedAt}:${operationId}`;
    this.db.prepare(`INSERT OR IGNORE INTO collection_feedback(
      sample_id,user_id,character_id,character_instance_id,label,revision,created_at) VALUES(?,?,?,?,?,?,?)`)
      .run(id, pairing.userId, pairing.characterId, pairing.characterInstanceId, 'missing', 0, this.now());
    return { id };
  }

  /** P1-5: Mark two-channel samples correlated to the same capture. */
  annotateCorrelation(pairing: PairingScope, sampleIds: readonly string[]): void {
    if (sampleIds.length < 2) return;
    this.db.transaction(() => {
      const idsJson = JSON.stringify(sampleIds);
      const stmt = this.db.prepare(`
        UPDATE collection_samples
        SET origin='correlated_capture', correlated_source_ids=?
        WHERE id=? AND user_id=? AND character_id=? AND character_instance_id=?
      `);
      for (const id of sampleIds) {
        stmt.run(idsJson, id, pairing.userId, pairing.characterId, pairing.characterInstanceId);
      }
    }).immediate();
  }

  /** Invalidate samples and write tombstones so a late task or rescan cannot resurrect them. */
  erase(input: {
    pairing: PairingScope; scope: 'item' | 'range' | 'all' | 'source';
    sampleId?: string; from?: string; to?: string; sourceKind?: CollectionSourceKind | CompanionSourceKind;
    expectedRevision: number; operationId: string;
  }): { affected: number; revision: number } {
    return this.db.transaction(() => {
      if (input.expectedRevision !== this.revision) throw new Error('revision_conflict');
      const where: string[] = ['user_id=?', 'character_id=?', 'character_instance_id=?', "state='active'"];
      const args: unknown[] = [input.pairing.userId, input.pairing.characterId, input.pairing.characterInstanceId];
      if (input.scope === 'item') { where.push('id=?'); args.push(input.sampleId ?? ''); }
      if (input.scope === 'range') { where.push('received_at>=?', 'received_at<?'); args.push(input.from ?? '', input.to ?? ''); }
      if (input.scope === 'source') { where.push('source_kind=?'); args.push(input.sourceKind ?? ''); }

      const targets = this.db.prepare(`SELECT id, idempotency_key, source_kind, asset_id FROM collection_samples WHERE ${where.join(' AND ')}`).all(...args) as
        { id: string; idempotency_key: string; source_kind: string; asset_id: string | null }[];

      const tombstones = this.db.prepare(`INSERT OR IGNORE INTO collection_tombstones(pair_key,idempotency_key,reason,created_at) VALUES(?,?,?,?)`);
      const invalidate = this.db.prepare("UPDATE collection_samples SET state='invalidated', revision=revision+1 WHERE id=?");
      const pairKey = `${input.pairing.userId}|${input.pairing.characterId}|${input.pairing.characterInstanceId}`;

      let candidateAffected = 0;
      // N082-02: Cascade invalidation to candidates and derived text
      if (input.scope === 'source' && input.sourceKind) {
        const cands = this.db.prepare(`
          SELECT id, native_event_id FROM collection_candidates
          WHERE user_id=? AND character_id=? AND character_instance_id=? AND source_kind=? AND state='pending'
        `).all(input.pairing.userId, input.pairing.characterId, input.pairing.characterInstanceId, input.sourceKind) as { id: string; native_event_id: string }[];
        candidateAffected = cands.length;
        for (const c of cands) {
          tombstones.run(pairKey, c.native_event_id, input.scope, this.now());
        }
        this.db.prepare(`
          UPDATE collection_candidates SET state='invalidated', revision=revision+1
          WHERE user_id=? AND character_id=? AND character_instance_id=? AND source_kind=?
        `).run(input.pairing.userId, input.pairing.characterId, input.pairing.characterInstanceId, input.sourceKind);
      } else if (input.scope === 'all') {
        this.db.prepare(`
          UPDATE collection_candidates SET state='invalidated', revision=revision+1
          WHERE user_id=? AND character_id=? AND character_instance_id=?
        `).run(input.pairing.userId, input.pairing.characterId, input.pairing.characterInstanceId);
        this.db.prepare(`
          DELETE FROM collection_derived_text
          WHERE user_id=? AND character_id=? AND character_instance_id=?
        `).run(input.pairing.userId, input.pairing.characterId, input.pairing.characterInstanceId);
      }

      for (const target of targets) {
        tombstones.run(pairKey, target.idempotency_key, input.scope, this.now());
        invalidate.run(target.id);
        if (target.asset_id) this.#releaseAssetRef(target.asset_id);
      }

      if (targets.length === 0 && candidateAffected === 0) return { affected: 0, revision: this.revision };
      // The user's original screenshots are never in the managed asset area and are never removed here.
      this.#collectUnreferencedAssets();
      this.#bumpCollectionRevision();
      return { affected: targets.length, revision: this.revision };
    }).immediate();
  }

  /** Delete managed files whose ref count fell to zero. Called inside a transaction's caller context. */
  #collectUnreferencedAssets(): void {
    const orphans = this.db.prepare('SELECT asset_id, path FROM collection_assets WHERE ref_count<=0').all() as { asset_id: string; path: string }[];
    for (const orphan of orphans) {
      try { if (existsSync(orphan.path)) unlinkSync(orphan.path); } catch { /* managed copy cleanup */ }
      this.db.prepare('DELETE FROM collection_assets WHERE asset_id=?').run(orphan.asset_id);
    }
  }

  #tombstoned(pairing: PairingScope, idempotencyKey: string): boolean {
    const pairKey = `${pairing.userId}|${pairing.characterId}|${pairing.characterInstanceId}`;
    return this.db.prepare('SELECT 1 AS hit FROM collection_tombstones WHERE pair_key=? AND idempotency_key=?')
      .get(pairKey, idempotencyKey) !== undefined;
  }

  /** Expire samples past their own TTL, then enforce the managed byte ceiling deterministically. */
  expire(now = this.now()): { expired: number; evicted: number } {
    return this.db.transaction(() => {
      const expired = this.db.prepare(`SELECT id, asset_id FROM collection_samples WHERE state='active' AND expires_at<=?`).all(now) as
        { id: string; asset_id: string | null }[];
      const update = this.db.prepare("UPDATE collection_samples SET state='invalidated', revision=revision+1 WHERE id=?");
      for (const row of expired) {
        update.run(row.id);
        if (row.asset_id) this.#releaseAssetRef(row.asset_id);
      }
      const evicted = this.#enforceCapacity();
      if (expired.length > 0) this.#bumpCollectionRevision();
      return { expired: expired.length, evicted };
    }).immediate();
  }

  /** Oldest-first eviction until the managed byte budget is satisfied. Returns how many were evicted. */
  #enforceCapacity(): number {
    let bytes = this.managedBytes();
    if (bytes <= this.policy.managedByteLimit) return 0;
    let evicted = 0;
    const candidates = this.db.prepare(`SELECT s.id, s.asset_id, a.bytes FROM collection_samples s
      JOIN collection_assets a ON a.asset_id=s.asset_id
      WHERE s.state='active' ORDER BY s.received_at ASC, s.id ASC`).all() as { id: string; asset_id: string; bytes: number }[];
    const update = this.db.prepare("UPDATE collection_samples SET state='invalidated', revision=revision+1 WHERE id=?");
    // Eviction writes the same tombstone shape as an explicit delete, so a rescan cannot bring it back.
    const tombstone = this.db.prepare(`INSERT OR IGNORE INTO collection_tombstones(pair_key,idempotency_key,reason,created_at)
      SELECT user_id||'|'||character_id||'|'||character_instance_id, idempotency_key, 'capacity', ? FROM collection_samples WHERE id=?`);
    for (const row of candidates) {
      if (bytes <= this.policy.managedByteLimit) break;
      tombstone.run(this.now(), row.id);
      update.run(row.id);
      this.#releaseAssetRef(row.asset_id);
      // P1-6: A shared asset is only reclaimed once all references fall to zero.
      const remaining = this.db.prepare('SELECT ref_count FROM collection_assets WHERE asset_id=?').get(row.asset_id) as { ref_count: number } | undefined;
      if (!remaining || remaining.ref_count <= 0) {
        bytes -= row.bytes;
      }
      evicted++;
    }
    this.#collectUnreferencedAssets();
    return evicted;
  }

  managedBytes(): number {
    const assetBytes = (this.db.prepare('SELECT COALESCE(SUM(bytes),0) AS total FROM collection_assets').get() as { total: number }).total;
    const textBytes = (this.db.prepare(`
      SELECT COALESCE(SUM(LENGTH(text_content)), 0) AS total FROM collection_candidates WHERE state='pending'
    `).get() as { total: number }).total;
    const derivedBytes = (this.db.prepare(`
      SELECT COALESCE(SUM(LENGTH(text_content)), 0) AS total FROM collection_derived_text
    `).get() as { total: number }).total;
    return assetBytes + textBytes + derivedBytes;
  }

  stats(pairing: PairingScope): CollectionStats {
    const scope = [pairing.userId, pairing.characterId, pairing.characterInstanceId];
    const active = (this.db.prepare(`SELECT COUNT(*) AS n FROM collection_samples
      WHERE user_id=? AND character_id=? AND character_instance_id=? AND state='active' AND expires_at>?`).get(...scope, this.now()) as { n: number }).n;
    const invalidated = (this.db.prepare(`SELECT COUNT(*) AS n FROM collection_samples
      WHERE user_id=? AND character_id=? AND character_instance_id=? AND state='invalidated'`).get(...scope) as { n: number }).n;
    return {
      managedBytes: this.managedBytes(),
      activeSamples: active,
      invalidatedSamples: invalidated,
      assets: (this.db.prepare('SELECT COUNT(*) AS n FROM collection_assets').get() as { n: number }).n,
    };
  }

  /** Per-source counters for the current pairing. Zero counts must never be reported as healthy. */
  sourceStatus(pairing: PairingScope, kind: CollectionSourceKind, grant: CollectionGrant | null): CollectionSourceStatus {
    const counter = this.db.prepare(`SELECT * FROM collection_counters
      WHERE user_id=? AND character_id=? AND character_instance_id=? AND kind=?`)
      .get(pairing.userId, pairing.characterId, pairing.characterInstanceId, kind) as Record<string, unknown> | undefined;
    const lastAccepted = this.db.prepare(`SELECT MAX(received_at) AS at FROM collection_samples
      WHERE user_id=? AND character_id=? AND character_instance_id=? AND source_kind=? AND state='active'`)
      .get(pairing.userId, pairing.characterId, pairing.characterInstanceId, kind) as { at: string | null };
    return Object.freeze({
      kind,
      state: grant ? grant.state : 'disabled',
      revision: grant?.revision ?? 0,
      grantExpiresAt: grant?.expiresAt ?? null,
      // The directory display path is only ever surfaced to the authenticated local console.
      directoryDisplayPath: grant?.directoryRoot ?? null,
      lastAcceptedAt: counter?.last_accepted_at === null || counter?.last_accepted_at === undefined
        ? (lastAccepted.at ?? null) : String(counter.last_accepted_at),
      accepted: Number(counter?.accepted ?? 0),
      duplicates: Number(counter?.duplicates ?? 0),
      rejected: Number(counter?.rejected ?? 0),
      dropped: Number(counter?.dropped ?? 0),
      lastErrorCode: counter?.last_error_code === null || counter?.last_error_code === undefined ? null : String(counter.last_error_code),
    });
  }

  #bumpCounter(pairing: PairingScope, kind: CollectionSourceKind, field: 'accepted' | 'duplicates' | 'rejected' | 'dropped', errorCode?: string): void {
    const key = [pairing.userId, pairing.characterId, pairing.characterInstanceId, kind];
    this.db.prepare(`INSERT OR IGNORE INTO collection_counters(
      user_id,character_id,character_instance_id,kind) VALUES(?,?,?,?)`).run(...key);
    const now = this.now();
    if (field === 'accepted') {
      this.db.prepare(`UPDATE collection_counters SET accepted=accepted+1, last_accepted_at=?
        WHERE user_id=? AND character_id=? AND character_instance_id=? AND kind=?`).run(now, ...key);
    } else {
      this.db.prepare(`UPDATE collection_counters SET ${field}=${field}+1, last_error_code=COALESCE(?, last_error_code)
        WHERE user_id=? AND character_id=? AND character_instance_id=? AND kind=?`).run(errorCode ?? null, ...key);
    }
  }

  status(pairing: PairingScope, instanceId: string, grantOf: (kind: CollectionSourceKind) => CollectionGrant | null): CollectionStatus {
    return Object.freeze({
      pairing, instanceId, collectionRevision: this.revision,
      profile: this.policy.profile, policyVersion: this.policy.policyVersion, policy: this.policy,
      managedBytes: this.managedBytes(),
      queueItems: 0,
      queueBytes: 0,
      sources: Object.freeze(SOURCE_KINDS.map(kind => this.sourceStatus(pairing, kind, grantOf(kind)))),
    });
  }

  // ===============================================================================================
  // N082-02: Candidates, Derived Text, and Batch/Observation Job Ports
  // ===============================================================================================

  appendCandidate(
    grant: CollectionGrant | SourceGrant,
    candidate: {
      readonly sourceKind: CompanionSourceKind;
      readonly modeGeneration: number;
      readonly nativeEventId: string;
      readonly occurredAt?: string | null;
      readonly receivedAt: string;
      readonly origin: string;
      readonly confidence: number;
      readonly expiresAt: string;
      readonly payloadRef: string;
      readonly textContent?: string | null;
      readonly displayName?: string;
      readonly mimeType?: string;
      readonly size?: number;
      readonly canonicalRootId?: string;
      readonly stableVersion?: string;
    },
    idempotencyKey: string,
  ): AppendResult {
    return this.db.transaction(() => {
      const pairing = grant.pairing;
      const pairKey = `${pairing.userId}|${pairing.characterId}|${pairing.characterInstanceId}`;
      const tombstone = this.db.prepare(`
        SELECT 1 FROM collection_tombstones
        WHERE pair_key=? AND (idempotency_key=? OR idempotency_key=?)
      `).get(pairKey, idempotencyKey, candidate.nativeEventId);
      if (tombstone) return { outcome: 'rejected' as const, sampleId: null, reason: 'tombstoned' };

      const existing = this.db.prepare(`
        SELECT id FROM collection_candidates
        WHERE user_id=? AND character_id=? AND character_instance_id=? AND source_kind=? AND native_event_id=?
      `).get(pairing.userId, pairing.characterId, pairing.characterInstanceId, candidate.sourceKind, candidate.nativeEventId) as { id: string } | undefined;

      if (existing) {
        return { outcome: 'duplicate' as const, sampleId: existing.id, reason: 'already_exists' };
      }

      const id = `cand-${randomUUID()}`;
      this.db.prepare(`
        INSERT INTO collection_candidates(
          id, revision, user_id, character_id, character_instance_id, source_kind,
          grant_id, grant_revision, mode_generation, native_event_id,
          occurred_at, received_at, origin, confidence, state, expires_at,
          payload_ref, text_content, display_name, mime_type, size,
          canonical_root_id, stable_version, created_at)
        VALUES(?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, pairing.userId, pairing.characterId, pairing.characterInstanceId, candidate.sourceKind,
        grant.grantId, grant.revision, candidate.modeGeneration, candidate.nativeEventId,
        candidate.occurredAt ?? null, candidate.receivedAt, candidate.origin, candidate.confidence, candidate.expiresAt,
        candidate.payloadRef, candidate.textContent ?? null, candidate.displayName ?? null, candidate.mimeType ?? null,
        candidate.size ?? null, candidate.canonicalRootId ?? null, candidate.stableVersion ?? null, this.now(),
      );

      this.#bumpCollectionRevision();
      return { outcome: 'inserted' as const, sampleId: id, reason: null };
    }).immediate();
  }

  listPending(pairing: PairingScope, cutoff?: string, limit = 50): readonly SourceCandidate[] {
    const rows = this.db.prepare(`
      SELECT * FROM collection_candidates
      WHERE user_id=? AND character_id=? AND character_instance_id=? AND state='pending'
        ${cutoff ? 'AND received_at <= ?' : ''}
      ORDER BY received_at ASC
      LIMIT ?
    `).all(
      ...[pairing.userId, pairing.characterId, pairing.characterInstanceId, ...(cutoff ? [cutoff] : []), limit],
    ) as Record<string, unknown>[];

    return Object.freeze(rows.map(row => ({
      id: String(row.id),
      revision: Number(row.revision),
      pairing,
      sourceKind: row.source_kind as CompanionSourceKind,
      grantId: String(row.grant_id),
      grantRevision: Number(row.grant_revision),
      modeGeneration: Number(row.mode_generation),
      nativeEventId: String(row.native_event_id),
      occurredAt: row.occurred_at ? String(row.occurred_at) : null,
      receivedAt: String(row.received_at),
      origin: String(row.origin),
      confidence: Number(row.confidence),
      state: row.state as SourceCandidate['state'],
      expiresAt: String(row.expires_at),
      payloadRef: String(row.payload_ref),
      displayName: row.display_name ? String(row.display_name) : undefined,
      mimeType: row.mime_type ? String(row.mime_type) : undefined,
      size: row.size ? Number(row.size) : undefined,
      canonicalRootId: row.canonical_root_id ? String(row.canonical_root_id) : undefined,
      stableVersion: row.stable_version ? String(row.stable_version) : undefined,
      textByteCount: row.text_content ? Buffer.byteLength(String(row.text_content), 'utf8') : undefined,
    })));
  }

  commitDerived(
    pairing: PairingScope,
    input: {
      readonly parentRefs: readonly { readonly sourceId: string; readonly version: string }[];
      readonly processorId: string;
      readonly processorVersion: string;
      readonly grantRevision: number;
      readonly processingKey: string;
      readonly status: DerivedTextStatus;
      readonly text: string;
      readonly warnings?: readonly string[];
      readonly expiresAt: string;
    },
  ): { readonly id: string; readonly revision: number } {
    return this.db.transaction(() => {
      const existing = this.db.prepare(`
        SELECT id, revision FROM collection_derived_text
        WHERE user_id=? AND character_id=? AND character_instance_id=? AND processing_key=?
      `).get(pairing.userId, pairing.characterId, pairing.characterInstanceId, input.processingKey) as { id: string; revision: number } | undefined;

      if (existing) {
        return existing;
      }

      const id = `dt-${randomUUID()}`;
      this.db.prepare(`
        INSERT INTO collection_derived_text(
          id, revision, user_id, character_id, character_instance_id,
          parent_refs_json, processor_id, processor_version, grant_revision,
          processing_key, created_at, expires_at, status, text_content, warnings_json)
        VALUES(?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, pairing.userId, pairing.characterId, pairing.characterInstanceId,
        JSON.stringify(input.parentRefs), input.processorId, input.processorVersion,
        input.grantRevision, input.processingKey, this.now(), input.expiresAt,
        input.status, input.text, JSON.stringify(input.warnings ?? []),
      );

      // Mark parent pending candidates as processed
      const markProcessed = this.db.prepare(`
        UPDATE collection_candidates SET state='processed', revision=revision+1 WHERE id=?
      `);
      for (const parent of input.parentRefs) {
        markProcessed.run(parent.sourceId);
      }

      this.#bumpCollectionRevision();
      return { id, revision: 1 };
    }).immediate();
  }

  queryEffective(
    pairing: PairingScope,
    filters?: { readonly sourceKind?: string; readonly from?: string; readonly to?: string; readonly limit?: number },
  ): { readonly candidates: readonly SourceCandidate[]; readonly derived: readonly DerivedText[] } {
    const limit = Math.max(1, Math.min(filters?.limit ?? 50, 100));
    const now = this.now();

    const candRows = this.db.prepare(`
      SELECT * FROM collection_candidates
      WHERE user_id=? AND character_id=? AND character_instance_id=?
        AND state IN ('pending', 'processed') AND expires_at > ?
        ${filters?.sourceKind ? 'AND source_kind=?' : ''}
        ${filters?.from ? 'AND received_at >= ?' : ''}
        ${filters?.to ? 'AND received_at < ?' : ''}
      ORDER BY received_at DESC LIMIT ?
    `).all(
      ...[
        pairing.userId, pairing.characterId, pairing.characterInstanceId, now,
        ...(filters?.sourceKind ? [filters.sourceKind] : []),
        ...(filters?.from ? [filters.from] : []),
        ...(filters?.to ? [filters.to] : []),
        limit,
      ],
    ) as Record<string, unknown>[];

    const derivedRows = this.db.prepare(`
      SELECT * FROM collection_derived_text
      WHERE user_id=? AND character_id=? AND character_instance_id=?
        AND status='ok' AND expires_at > ?
      ORDER BY created_at DESC LIMIT ?
    `).all(pairing.userId, pairing.characterId, pairing.characterInstanceId, now, limit) as Record<string, unknown>[];

    const candidates = candRows.map(row => ({
      id: String(row.id),
      revision: Number(row.revision),
      pairing,
      sourceKind: row.source_kind as CompanionSourceKind,
      grantId: String(row.grant_id),
      grantRevision: Number(row.grant_revision),
      modeGeneration: Number(row.mode_generation),
      nativeEventId: String(row.native_event_id),
      occurredAt: row.occurred_at ? String(row.occurred_at) : null,
      receivedAt: String(row.received_at),
      origin: String(row.origin),
      confidence: Number(row.confidence),
      state: row.state as SourceCandidate['state'],
      expiresAt: String(row.expires_at),
      payloadRef: String(row.payload_ref),
    }));

    const derived = derivedRows.map(row => ({
      id: String(row.id),
      revision: Number(row.revision),
      parentRefs: JSON.parse(String(row.parent_refs_json)) as { sourceId: string; version: string }[],
      processorId: String(row.processor_id),
      processorVersion: String(row.processor_version),
      grantRevision: Number(row.grant_revision),
      processingKey: String(row.processing_key),
      createdAt: String(row.created_at),
      expiresAt: String(row.expires_at),
      status: row.status as DerivedTextStatus,
      textRef: String(row.id),
      warnings: JSON.parse(String(row.warnings_json)) as string[],
    }));

    return { candidates: Object.freeze(candidates), derived: Object.freeze(derived) };
  }

  claimJob(input: {
    readonly pairing: PairingScope;
    readonly kind: JobKind;
    readonly trigger: JobTrigger;
    readonly policyRevision: number;
    readonly generation: number;
    readonly scheduledDay: string;
    readonly cutoff: string;
  }): JobStatus {
    return this.db.transaction(() => {
      const jobId = `job-${randomUUID()}`;
      const now = this.now();
      this.db.prepare(`
        INSERT INTO collection_jobs(
          job_id, user_id, character_id, character_instance_id, kind, trigger,
          policy_revision, generation, scheduled_day, cutoff, state, started_at)
        VALUES(?,?,?,?,?,?,?,?,?,?, 'running', ?)
      `).run(
        jobId, input.pairing.userId, input.pairing.characterId, input.pairing.characterInstanceId,
        input.kind, input.trigger, input.policyRevision, input.generation,
        input.scheduledDay, input.cutoff, now,
      );

      return {
        jobId,
        pairing: input.pairing,
        kind: input.kind,
        trigger: input.trigger,
        policyRevision: input.policyRevision,
        generation: input.generation,
        scheduledDay: input.scheduledDay,
        cutoff: input.cutoff,
        state: 'running' as const,
        startedAt: now,
        finishedAt: null,
        checkpoint: null,
        counts: { accepted: 0, processed: 0, failed: 0, skipped: 0, dropped: 0 },
        reasonCode: null,
      };
    }).immediate();
  }

  finishJob(jobId: string, updates: {
    readonly state: JobState;
    readonly counts?: { readonly accepted: number; readonly processed: number; readonly failed: number; readonly skipped: number; readonly dropped: number };
    readonly checkpoint?: string | null;
    readonly reasonCode?: string | null;
  }): void {
    const now = this.now();
    this.db.prepare(`
      UPDATE collection_jobs SET
        state=?, finished_at=?, checkpoint=COALESCE(?, checkpoint),
        accepted_count=COALESCE(?, accepted_count), processed_count=COALESCE(?, processed_count),
        failed_count=COALESCE(?, failed_count), skipped_count=COALESCE(?, skipped_count),
        dropped_count=COALESCE(?, dropped_count), reason_code=COALESCE(?, reason_code)
      WHERE job_id=?
    `).run(
      updates.state, now, updates.checkpoint ?? null,
      updates.counts?.accepted ?? null, updates.counts?.processed ?? null,
      updates.counts?.failed ?? null, updates.counts?.skipped ?? null,
      updates.counts?.dropped ?? null, updates.reasonCode ?? null, jobId,
    );
  }

  close(): void { /* the companion database is owned by SqliteMemoryStore */ }
}

function extensionFor(mimeType: string): string {
  if (mimeType === 'image/jpeg') return '.jpg';
  if (mimeType === 'image/webp') return '.webp';
  if (mimeType === 'image/bmp') return '.bmp';
  return '.png';
}
