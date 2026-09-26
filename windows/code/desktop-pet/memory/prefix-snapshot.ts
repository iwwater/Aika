// FIX61-09: frozen context prefix storage (R-TODO-09).
//
// What this file owns:
//   * the durable PrefixSnapshot record: one frozen identity + knowledge + summary + core-memory +
//     recent-history block, its byte hash, the exact source versions it pinned, a history watermark and
//     a revocation revision;
//   * the CAS publish path. Inside ONE write transaction the build must still be the newest one for its
//     conversation boundary, its captured key must still equal live state, and its privacy revision must
//     still equal live state. A build that raced a library switch, a prompt edit or a forget is rejected
//     with `prefix_snapshot_superseded` and the previously published snapshot is left untouched;
//   * the refresh policy. The default is `next-start`: this run freezes what it published, the next
//     start rebuilds it, and an optional interval refresh stays off unless a caller configures it
//     (PREFIX_REFRESH_INTERVAL_MS, default six hours);
//   * lightweight per-turn validation. An ordinary foreground turn compares the pinned sources, the
//     revocation revision and a bounded recent window. It never re-runs whole-library retrieval just to
//     prove that its frozen prefix is still allowed.
//
// What it deliberately does NOT do:
//   * it never claims a provider KV-cache hit. Freezing makes the LOCAL request stable; whether a vendor
//     caches it, for how long, and at what price is outside this process, and the logical input token
//     count does not go down;
//   * it does not implement Soul/Persona (0.7), and it does not become a second knowledge or revocation
//     counter - knowledge revocation is consumed from KnowledgeSelection.revision;
//   * it does not remove assertContextCurrent, and it does not treat ordinary memory growth as
//     revocation. Growth is deferred to the next snapshot; correction, forget, knowledge removal or
//     switch, and a tightened privacy boundary revoke the frozen prefix immediately.
import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import type { CharacterId, ConversationMessage, MemoryReference, TurnScope } from '../contracts/index.js';
import type { DialoguePrefix, PrefixMessage } from '../contracts/prefix.js';
import { MemoryRuleError } from './scope.js';
import type { SqliteMemoryStore } from './sqlite-store.js';

export type PrefixRefreshMode = 'next-start' | 'interval';
/** Default interval refresh. Only used when a caller explicitly selects the `interval` mode. */
export const PREFIX_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Bounded build attempts. A superseded build retries at most this many times, never unbounded. */
export const PREFIX_BUILD_ATTEMPTS = 2;
/** The lightweight validation window. It is a bounded read, not a second retrieval pass. */
export const PREFIX_MESSAGE_LIMIT = 8;
/** Default upper bound for the dynamic suffix, in UTF-8 bytes. */
export const PREFIX_DEFAULT_SUFFIX_BYTES = 32 * 1024;

export type { PrefixMessage };

export interface PrefixSourceVersion { readonly id: string; readonly version: number }
export interface PrefixKnowledgeKey {
  readonly libraryId: string;
  readonly libraryRevision: number;
  /** Knowledge revocation revision. Import, edit, document removal, library deletion and switch raise it. */
  readonly revision: number;
}

export interface PrefixKey {
  readonly characterId: string;
  readonly sessionId: string;
  readonly identityHash: string;
  readonly policyRevision: number;
  readonly privacyRevision: number;
  readonly protocol: string;
  readonly model: string;
  readonly tokenBudget: number;
  /** null means 'no knowledge library selected'; an empty library is a different, non-null state. */
  readonly knowledge: PrefixKnowledgeKey | null;
  /** Ordinals, revisions, locators and text of the delivered blocks: the exact library input. */
  readonly knowledgeFingerprint: string;
  readonly maxMemories: number;
  readonly summaryLimit: number;
}

export interface PrefixSnapshotRecord {
  readonly id: string;
  readonly key: PrefixKey;
  readonly revision: number;
  readonly prefixText: string;
  readonly hash: string;
  readonly sources: readonly PrefixSourceVersion[];
  readonly historyWatermark: number;
  readonly builtAt: string;
  readonly privacyRevision: number;
  readonly summary: string;
  readonly memories: readonly MemoryReference[];
  readonly messages: readonly PrefixMessage[];
}

export interface PrefixCandidate {
  readonly text: string;
  readonly hash: string;
  readonly summary: string;
  readonly memories: readonly MemoryReference[];
  readonly messages: readonly PrefixMessage[];
  readonly sources: readonly PrefixSourceVersion[];
  readonly watermark: number;
}

export interface PrefixPublishInput {
  readonly snapshot: { readonly id: string; readonly revision: number };
  readonly candidate: PrefixCandidate;
  /** Key re-read from live state immediately before publishing. */
  readonly currentKey: PrefixKey;
  /** Revocation revision re-read immediately before publishing. */
  readonly currentPrivacyRevision: number;
}

export interface PrefixLiveState { readonly key: PrefixKey; readonly privacyRevision: number }

interface SnapshotRow {
  id: string; character_id: string; session_id: string; revision: number; key_json: string; prefix_text: string;
  prefix_hash: string; sources_json: string; messages_json: string; summary_text: string; memories_json: string;
  watermark: number; privacy_revision: number; built_at: string; status: string;
}

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return '{' + entries.map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
  }
  return JSON.stringify(value);
};
export const hashText = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
export const hashValue = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');
export const sameKey = (a: PrefixKey, b: PrefixKey): boolean => canonical(a) === canonical(b);

const NL = String.fromCharCode(10);
const BLANK = String.fromCharCode(10, 10);
/** Single quote, kept as a constant so the SQL literals below stay readable. */
const Q = String.fromCharCode(39);

/**
 * The frozen text the provider receives first. Only snapshot-stable parts live here: no turn id, no
 * timestamp, no random ordering, no per-turn perception. A prefix that does not fit its own budget is a
 * configuration error reported to the caller, never a silently truncated prefix.
 */
export function renderPrefixText(id: string, identity: string, knowledge: string | null, summary: string, memories: readonly MemoryReference[]): string {
  const parts: string[] = ['[\u51bb\u7ed3\u4e0a\u4e0b\u6587\u524d\u7f00 ' + id + ']', identity.trim()];
  if (knowledge && knowledge.trim()) parts.push(knowledge.trim());
  if (summary.trim()) parts.push('\u9636\u6bb5\u6458\u8981\uff1a' + NL + summary.trim());
  if (memories.length) parts.push('\u76f8\u5173\u957f\u671f\u8bb0\u5fc6\uff1a' + NL + memories.map(memory => '- ' + memory.text).join(NL));
  return parts.join(BLANK);
}

/**
 * The bounded recent tail frozen into one prefix. A trailing turn with no assistant reply yet is
 * dropped, so a prefix never pins a question without its answer and never duplicates the current input,
 * which the provider appends exactly once as the last user message.
 */
export function freezeMessages(recent: readonly { readonly id: string; readonly role: 'user' | 'assistant'; readonly text: string }[], currentText = ''): PrefixMessage[] {
  const items = [...recent].slice(-PREFIX_MESSAGE_LIMIT);
  const last = items[items.length - 1];
  // The current input is removed here because the provider appends it exactly once, after the prefix.
  // Older turns stay: they are already committed history, not the turn being served right now.
  if (last && last.role === 'user' && last.text === currentText) items.pop();
  return items.map(message => ({ id: message.id, role: message.role, text: message.text }));
}

export function toPrefixMessage(message: ConversationMessage): PrefixMessage {
  return { id: message.id, role: message.role, text: message.text };
}

export function dialoguePrefix(record: PrefixSnapshotRecord, messages: readonly PrefixMessage[], suffixBytes: number, complete: boolean): DialoguePrefix {
  return Object.freeze({ id: record.id, revision: record.revision, hash: record.hash, text: record.prefixText, messages: [...messages], sources: record.sources.map(source => ({ ...source })), suffixBytes, complete });
}

export interface PrefixSnapshotStoreOptions {
  readonly clock: () => string;
  readonly mode?: PrefixRefreshMode;
  readonly intervalMs?: number;
}

/** Durable prefix storage inside the existing companion database; there is no second snapshot database. */
export class PrefixSnapshotStore {
  constructor(private readonly db: Database.Database, private readonly options: PrefixSnapshotStoreOptions) {
    db.exec('CREATE TABLE IF NOT EXISTS memory_prefix_snapshots('
      + 'id TEXT PRIMARY KEY, character_id TEXT NOT NULL, session_id TEXT NOT NULL, revision INTEGER NOT NULL,'
      + 'key_json TEXT NOT NULL, prefix_text TEXT NOT NULL, prefix_hash TEXT NOT NULL, sources_json TEXT NOT NULL,'
      + 'messages_json TEXT NOT NULL, summary_text TEXT NOT NULL, memories_json TEXT NOT NULL, watermark INTEGER NOT NULL,'
      + 'privacy_revision INTEGER NOT NULL, built_at TEXT NOT NULL, status TEXT NOT NULL,'
      + 'CHECK(status IN (' + Q + 'building' + Q + ',' + Q + 'active' + Q + ',' + Q + 'failed' + Q + ')));'
      + 'CREATE INDEX IF NOT EXISTS memory_prefix_by_session ON memory_prefix_snapshots(character_id,session_id,status);');
  }

  get mode(): PrefixRefreshMode { return this.options.mode ?? 'next-start'; }
  get intervalMs(): number { return this.options.intervalMs ?? PREFIX_REFRESH_INTERVAL_MS; }
  now(): string { return this.options.clock(); }

  /**
   * Persistent revocation revision for one character. It is raised whenever the durable privacy
   * boundary changes in any direction, so it survives a restart and cannot be reset by reopening the
   * database. It is stored in app_settings under `prefix_privacy:<character>`.
   */
  privacyRevision(store: SqliteMemoryStore, characterId: CharacterId): number {
    const boundary = store.pending.contextBoundary(characterId);
    const fingerprint = hashValue({ holds: boundary.holds, afterOrder: boundary.afterOrder });
    const key = 'prefix_privacy:' + characterId;
    const row = this.db.prepare('SELECT value FROM app_settings WHERE key=?').get(key) as { value: string } | undefined;
    const prior = row ? JSON.parse(row.value) as { revision: number; fingerprint: string } : null;
    if (prior && prior.fingerprint === fingerprint) return prior.revision;
    const revision = (prior?.revision ?? 0) + 1;
    this.db.prepare('INSERT INTO app_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(key, JSON.stringify({ revision, fingerprint }));
    return revision;
  }

  /**
   * Newest durable row for one conversation boundary. A row whose stored hash does not match its own
   * bytes (a torn write, an interrupted publish) is skipped, never restored as reusable.
   */
  load(scope: TurnScope): { record: PrefixSnapshotRecord; status: 'active' | 'building' | 'failed' } | null {
    const rows = this.db.prepare('SELECT * FROM memory_prefix_snapshots WHERE character_id=? AND session_id=? ORDER BY revision DESC,rowid DESC LIMIT ?')
      .all(scope.characterId, scope.sessionId, PREFIX_BUILD_ATTEMPTS + 2) as SnapshotRow[];
    for (const row of rows) {
      const decoded = this.#decode(row);
      if (decoded) return { record: decoded, status: row.status as 'active' | 'building' | 'failed' };
    }
    return null;
  }

  /**
   * The newest published row of this boundary that is still allowed to be used. Rows are considered newest
   * first and skipped when they are not active (an interrupted or failed build from another attempt), when
   * they no longer validate against live state, or - when `enforceTtl` is set - when the interval TTL has
   * passed. Skipping rather than failing is what keeps an interrupted background build from costing a run
   * the perfectly good snapshot it already had.
   */
  usable(store: SqliteMemoryStore, scope: TurnScope, live: PrefixLiveState, enforceTtl = false, at: string = this.now()): PrefixSnapshotRecord | null {
    const rows = this.db.prepare('SELECT * FROM memory_prefix_snapshots WHERE character_id=? AND session_id=? ORDER BY revision DESC,rowid DESC LIMIT ?')
      .all(scope.characterId, scope.sessionId, PREFIX_BUILD_ATTEMPTS + 2) as SnapshotRow[];
    for (const row of rows) {
      if (row.status !== 'active') continue;
      const record = this.#decode(row);
      if (!record) continue;
      if (enforceTtl && this.mode === 'interval' && Date.parse(at) - Date.parse(record.builtAt) >= this.intervalMs) continue;
      try { this.validate(store, record, scope, live); } catch { continue; }
      return record;
    }
    return null;
  }

  /**
   * The startup path: a row whose TTL has expired, that is not active, or whose pinned bytes no longer
   * match live state is NOT restored as directly reusable by a fresh run.
   */
  reusable(store: SqliteMemoryStore, scope: TurnScope, live: PrefixLiveState, at: string = this.now()): PrefixSnapshotRecord | null {
    return this.usable(store, scope, live, true, at);
  }

  /** Has this published snapshot passed the configured interval TTL? */
  expired(record: PrefixSnapshotRecord, at: string = this.now()): boolean {
    return this.mode === 'interval' && Date.parse(at) - Date.parse(record.builtAt) >= this.intervalMs;
  }

  /** Records the intent to rebuild. A newer build supersedes the previous pending row for this boundary. */
  beginBuild(scope: TurnScope, key: PrefixKey, privacyRevision: number): { id: string; revision: number } {
    const stem = 'prefix:' + scope.characterId + ':' + scope.sessionId + ':' + hashValue([key, privacyRevision]).slice(0, 16);
    return this.db.transaction(() => {
      const prior = this.load(scope);
      const revision = (prior?.record.revision ?? 0) + 1;
      // The revision is monotonic per boundary, so the identity of a build is unique without depending on
      // a wall-clock timestamp (which a fake or coarse clock may repeat).
      const id = stem + ':' + String(revision);
      this.db.prepare('UPDATE memory_prefix_snapshots SET status=' + Q + 'failed' + Q + ' WHERE character_id=? AND session_id=? AND status=' + Q + 'building' + Q)
        .run(scope.characterId, scope.sessionId);
      this.db.prepare('INSERT INTO memory_prefix_snapshots(id,character_id,session_id,revision,key_json,prefix_text,prefix_hash,sources_json,messages_json,summary_text,memories_json,watermark,privacy_revision,built_at,status)'
        + ' VALUES(?,?,?,?,?,' + Q + Q + ',' + Q + Q + ',' + Q + '[]' + Q + ',' + Q + '[]' + Q + ',' + Q + Q + ',' + Q + '[]' + Q + ',?,?,?,' + Q + 'building' + Q + ')')
        .run(id, scope.characterId, scope.sessionId, revision, canonical(key), 0, privacyRevision, this.now());
      return { id, revision };
    }).immediate();
  }

  /**
   * Atomic publish with compare-and-swap. Everything is compared inside one immediate transaction, so a
   * build that raced a library switch, a prompt edit, a policy change or a forget can never replace a
   * newer snapshot with stale content.
   */
  publish(input: PrefixPublishInput): PrefixSnapshotRecord {
    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM memory_prefix_snapshots WHERE id=?').get(input.snapshot.id) as SnapshotRow | undefined;
      if (!row || row.status !== 'building') throw new MemoryRuleError('prefix_snapshot_superseded');
      const newest = this.db.prepare('SELECT max(revision) AS revision FROM memory_prefix_snapshots WHERE character_id=? AND session_id=?')
        .get(row.character_id, row.session_id) as { revision: number | null };
      if ((newest.revision ?? 0) !== row.revision) throw new MemoryRuleError('prefix_snapshot_superseded');
      if (row.privacy_revision !== input.currentPrivacyRevision) throw new MemoryRuleError('prefix_snapshot_superseded');
      if (row.key_json !== canonical(input.currentKey)) throw new MemoryRuleError('prefix_snapshot_superseded');
      const candidate = input.candidate;
      const hash = hashText(candidate.text);
      if (candidate.hash !== hash) throw new MemoryRuleError('prefix_snapshot_hash_mismatch');
      this.db.prepare('UPDATE memory_prefix_snapshots SET prefix_text=?,prefix_hash=?,sources_json=?,messages_json=?,summary_text=?,memories_json=?,watermark=?,built_at=?,status=' + Q + 'active' + Q + ' WHERE id=?')
        .run(candidate.text, hash, JSON.stringify(candidate.sources), JSON.stringify(candidate.messages), candidate.summary, JSON.stringify(candidate.memories), candidate.watermark, this.now(), input.snapshot.id);
      const published = this.load({ characterId: row.character_id as CharacterId, sessionId: row.session_id, turnId: 'prefix-publish', generation: 0 });
      if (!published || published.record.id !== input.snapshot.id) throw new MemoryRuleError('prefix_snapshot_publish_failed');
      return published.record;
    }).immediate();
  }

  /** A failed or abandoned build keeps the previously published snapshot active. */
  fail(snapshot: { id: string }): void {
    this.db.prepare('UPDATE memory_prefix_snapshots SET status=' + Q + 'failed' + Q + ' WHERE id=? AND status=' + Q + 'building' + Q).run(snapshot.id);
  }

  /**
   * Lightweight validation of an already published prefix against live state. It compares the full
   * key (identity, policy, protocol/model/budget, knowledge library and revision, privacy revision),
   * every pinned source version, and one bounded recent window. It performs no whole-library retrieval.
   */
  validate(store: SqliteMemoryStore, record: PrefixSnapshotRecord, scope: TurnScope, live: PrefixLiveState): void {
    if (record.key.characterId !== scope.characterId || record.key.sessionId !== scope.sessionId) throw new MemoryRuleError('prefix_snapshot_stale');
    if (!sameKey(record.key, live.key) || record.privacyRevision !== live.privacyRevision) throw new MemoryRuleError('prefix_snapshot_stale');
    for (const source of record.sources) {
      const actual = store.inspect(scope, source.id);
      if (!actual || actual.state !== 'active' || actual.version !== source.version || actual.evidenceEligible === false) throw new MemoryRuleError('prefix_snapshot_stale');
    }
    for (const message of store.contextRecords(scope, '', PREFIX_MESSAGE_LIMIT, 0, 0).recent) {
      const actual = store.inspect(scope, message.id);
      if (!actual || actual.state !== 'active' || actual.evidenceEligible === false) throw new MemoryRuleError('prefix_snapshot_stale');
    }
  }

  #decode(row: SnapshotRow): PrefixSnapshotRecord | null {
    try {
      const key = JSON.parse(row.key_json) as PrefixKey;
      const sources = JSON.parse(row.sources_json) as PrefixSourceVersion[];
      const messages = JSON.parse(row.messages_json) as PrefixMessage[];
      const memories = JSON.parse(row.memories_json) as MemoryReference[];
      if (row.status === 'active' && hashText(row.prefix_text) !== row.prefix_hash) return null;
      return { id: row.id, key, revision: row.revision, prefixText: row.prefix_text, hash: row.prefix_hash, sources, historyWatermark: row.watermark, builtAt: row.built_at, privacyRevision: row.privacy_revision, summary: row.summary_text, memories, messages };
    } catch { return null; }
  }
}
