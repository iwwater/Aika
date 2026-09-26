/** K65-04: optional long-memory compatibility package state, backup and revocation boundary. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export interface CompatibilityRecord {
  readonly id: string;
  readonly version: number;
  readonly sourceId: string;
  readonly value: unknown;
}

export interface CompatibilitySnapshot {
  readonly snapshotId: string;
  readonly revision: number;
  readonly sourceIds: readonly string[];
  readonly records: readonly CompatibilityRecord[];
}

interface PersistedState {
  readonly schemaVersion: 1;
  readonly packageVersion: string;
  readonly revision: number;
  readonly enabled: boolean;
  readonly writerId: string | null;
  readonly records: readonly CompatibilityRecord[];
  readonly revokedSourceIds: readonly string[];
  readonly snapshots: readonly CompatibilitySnapshot[];
  readonly migrations: readonly { readonly sourceFile: string; readonly fingerprint: string }[];
}

export class CompatibilityRuntimeError extends Error {
  constructor(readonly code: 'writer_conflict' | 'not_enabled' | 'write_authority_missing' | 'record_conflict' | 'snapshot_revoked' | 'migration_failed', message: string) {
    super(message); this.name = 'CompatibilityRuntimeError';
  }
}

/** Canonical JSON used for migration fingerprints. Sorting is recursive: JSON.stringify's
 * replacer-array form only sorts/filter keys at every level and can erase nested content. */
function stable(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => stable(item)).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${stable(object[key])}`).join(',')}}`;
}
function digest(value: unknown): string { return createHash('sha256').update(stable(value)).digest('hex'); }

export interface CompatibilityRuntimeOptions { readonly packageVersion?: string; readonly enabled?: boolean; }

export class CompatibilityRuntime {
  private state: PersistedState;
  private readonly stateFile: string;
  private readonly backupDirectory: string;
  private closed = false;

  private constructor(private readonly root: string, state: PersistedState, options: CompatibilityRuntimeOptions) {
    this.stateFile = resolve(root, 'compatibility-state.json');
    this.backupDirectory = resolve(root, 'migration-backups');
    this.state = { ...state, packageVersion: options.packageVersion ?? state.packageVersion, enabled: options.enabled ?? state.enabled };
  }

  static open(root: string, options: CompatibilityRuntimeOptions = {}): CompatibilityRuntime {
    mkdirSync(root, { recursive: true });
    const stateFile = resolve(root, 'compatibility-state.json');
    let state: PersistedState = { schemaVersion: 1, packageVersion: options.packageVersion ?? '0.65.0', revision: 0, enabled: options.enabled ?? true, writerId: null, records: [], revokedSourceIds: [], snapshots: [], migrations: [] };
    if (existsSync(stateFile)) {
      const parsed = JSON.parse(readFileSync(stateFile, 'utf8')) as PersistedState;
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.records) || !Array.isArray(parsed.snapshots)) throw new CompatibilityRuntimeError('migration_failed', 'compatibility state schema is unsupported');
      state = { ...parsed, migrations: parsed.migrations ?? [] };
    }
    return new CompatibilityRuntime(root, state, options);
  }

  status(): { readonly enabled: boolean; readonly revision: number; readonly writerId: string | null; readonly recordCount: number; readonly snapshotCount: number } {
    return { enabled: this.state.enabled, revision: this.state.revision, writerId: this.state.writerId, recordCount: this.state.records.length, snapshotCount: this.state.snapshots.length };
  }

  registerWriter(writerId: string): () => void {
    this.ensureOpen(); this.ensureEnabled();
    if (this.state.writerId && this.state.writerId !== writerId) throw new CompatibilityRuntimeError('writer_conflict', `writer ${this.state.writerId} already owns compatibility writes`);
    this.state = { ...this.state, writerId }; this.persist();
    let released = false;
    return () => { if (released) return; released = true; if (this.state.writerId === writerId) { this.state = { ...this.state, writerId: null }; this.persist(); } };
  }

  append(record: CompatibilityRecord): void {
    this.ensureOpen(); this.ensureEnabled(); if (!this.state.writerId) throw new CompatibilityRuntimeError('write_authority_missing', 'compatibility writer is not registered');
    if (!record.id || !record.sourceId || !Number.isSafeInteger(record.version) || record.version < 1) throw new CompatibilityRuntimeError('record_conflict', 'record identity/version is invalid');
    if (this.state.revokedSourceIds.includes(record.sourceId)) throw new CompatibilityRuntimeError('snapshot_revoked', `source ${record.sourceId} has been revoked`);
    const prior = this.state.records.find(candidate => candidate.id === record.id);
    if (prior) {
      if (stable(prior.value) !== stable(record.value) || prior.sourceId !== record.sourceId) throw new CompatibilityRuntimeError('record_conflict', `record ${record.id} already belongs to another source/value`);
      return;
    }
    this.state = { ...this.state, revision: this.state.revision + 1, records: [...this.state.records, structuredClone(record)] };
    this.persist();
  }

  snapshot(snapshotId: string, sourceIds: readonly string[]): CompatibilitySnapshot {
    this.ensureOpen(); this.ensureEnabled();
    const sources = [...new Set(sourceIds)];
    if (sources.some(sourceId => this.state.revokedSourceIds.includes(sourceId))) throw new CompatibilityRuntimeError('snapshot_revoked', 'snapshot includes a revoked source');
    const snapshot: CompatibilitySnapshot = Object.freeze({ snapshotId, revision: this.state.revision, sourceIds: Object.freeze(sources), records: Object.freeze(this.state.records.filter(record => sources.includes(record.sourceId)).map(record => structuredClone(record))) });
    this.state = { ...this.state, snapshots: [...this.state.snapshots.filter(item => item.snapshotId !== snapshotId), snapshot] };
    this.persist();
    return snapshot;
  }

  assertSnapshot(snapshotId: string): CompatibilitySnapshot {
    this.ensureOpen();
    const snapshot = this.state.snapshots.find(item => item.snapshotId === snapshotId);
    if (!snapshot || snapshot.sourceIds.some(sourceId => this.state.revokedSourceIds.includes(sourceId))) throw new CompatibilityRuntimeError('snapshot_revoked', `snapshot ${snapshotId} is no longer valid`);
    return structuredClone(snapshot);
  }

  revokeSource(sourceId: string): void {
    this.ensureOpen();
    if (this.state.revokedSourceIds.includes(sourceId)) return;
    this.state = { ...this.state, revision: this.state.revision + 1, revokedSourceIds: [...this.state.revokedSourceIds, sourceId] };
    this.persist();
  }

  disable(): void { this.ensureOpen(); this.state = { ...this.state, enabled: false, writerId: null, revision: this.state.revision + 1 }; this.persist(); }
  enable(): void { this.ensureOpen(); this.state = { ...this.state, enabled: true, revision: this.state.revision + 1 }; this.persist(); }

  migrateJson<T>(sourceFile: string, transform: (value: unknown) => T): { readonly changed: boolean; readonly fingerprint: string; readonly value: T } {
    this.ensureOpen();
    try {
      const original = JSON.parse(readFileSync(sourceFile, 'utf8')) as unknown;
      const fingerprint = digest(original);
      const prior = this.state.migrations.find(item => item.sourceFile === sourceFile);
      if (prior) return { changed: false, fingerprint: prior.fingerprint, value: original as T };
      mkdirSync(this.backupDirectory, { recursive: true });
      const backup = resolve(this.backupDirectory, `${fingerprint}.json`);
      if (!existsSync(backup)) writeFileSync(backup, `${JSON.stringify(original, null, 2)}\n`, 'utf8');
      const value = transform(structuredClone(original));
      const next = `${sourceFile}.next`;
      writeFileSync(next, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
      renameSync(next, sourceFile);
      this.state = { ...this.state, migrations: [...this.state.migrations, { sourceFile, fingerprint }] };
      this.persist();
      return { changed: true, fingerprint, value };
    } catch (error) {
      throw new CompatibilityRuntimeError('migration_failed', `compatibility migration failed: ${(error as Error).message}`);
    }
  }

  backupFingerprints(): readonly string[] { return existsSync(this.backupDirectory) ? readdirSync(this.backupDirectory).filter(name => name.endsWith('.json')).map(name => name.slice(0, -5)).sort() : []; }
  close(): void { this.closed = true; this.state = { ...this.state, writerId: null }; this.persist(); }

  private ensureOpen(): void { if (this.closed) throw new CompatibilityRuntimeError('not_enabled', 'compatibility runtime is closed'); }
  private ensureEnabled(): void { if (!this.state.enabled) throw new CompatibilityRuntimeError('not_enabled', 'compatibility package is disabled'); }
  private persist(): void { mkdirSync(dirname(this.stateFile), { recursive: true }); const next = `${this.stateFile}.next`; writeFileSync(next, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8'); renameSync(next, this.stateFile); }
}
