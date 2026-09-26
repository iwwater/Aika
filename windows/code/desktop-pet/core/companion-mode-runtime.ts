/**
 * core/companion-mode-runtime.ts
 *
 * N082-01: Companion Mode & Grant State Machine Runtime.
 * Manages active/passive mode policies, source grant lifecycles, run generation,
 * session lock/suspend invalidation, and idempotent operation persistence.
 */

import { randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import type { PairingScope } from '../contracts/character-pack.js';
import type {
  CompanionMode,
  CompanionRunState,
  CompanionModePolicy,
  ModeStatus,
  CompanionSourceKind,
  SourceGrant,
  SourceGrantState,
  SourceGrantScope,
  SourceGrantPurpose,
  SourceGrantDestination,
} from '../contracts/companion-mode.js';
import { validateCompanionModePolicy } from '../contracts/companion-mode.js';

export interface CompanionModeRuntimeOptions {
  readonly db: Database;
  readonly pairing: PairingScope;
  readonly now?: (() => string) | undefined;
  readonly onSourceSync?: ((kind: CompanionSourceKind, active: boolean) => Promise<void>) | undefined;
  readonly onGenerationChange?: ((generation: number) => void) | undefined;
}

export class CompanionModeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'CompanionModeError';
  }
}

export class CompanionModeRuntime {
  private readonly db: Database;
  private readonly pairing: PairingScope;
  private readonly now: () => string;
  private readonly onSourceSync?: ((kind: CompanionSourceKind, active: boolean) => Promise<void>) | undefined;
  private readonly onGenerationChange?: ((generation: number) => void) | undefined;
  private generation = 1;
  private runState: CompanionRunState = 'paused';
  private leases = new Set<CompanionSourceKind>();

  constructor(options: CompanionModeRuntimeOptions) {
    this.db = options.db;
    this.pairing = options.pairing;
    this.now = options.now ?? (() => new Date().toISOString());
    this.onSourceSync = options.onSourceSync;
    this.onGenerationChange = options.onGenerationChange;
    this.#initSchema();
  }

  #initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS companion_mode_policy(
        user_id TEXT NOT NULL, character_id TEXT NOT NULL, character_instance_id TEXT NOT NULL,
        mode TEXT NOT NULL, observation_interval_ms INTEGER NOT NULL,
        daily_local_time TEXT NOT NULL, timezone TEXT NOT NULL,
        policy_version INTEGER NOT NULL, revision INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(user_id, character_id, character_instance_id));
      CREATE TABLE IF NOT EXISTS companion_mode_grants(
        grant_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL, character_id TEXT NOT NULL, character_instance_id TEXT NOT NULL,
        kind TEXT NOT NULL, scope_json TEXT NOT NULL, purposes_json TEXT NOT NULL,
        destination TEXT NOT NULL, profile TEXT NOT NULL, state TEXT NOT NULL,
        revision INTEGER NOT NULL, granted_at TEXT NOT NULL, expires_at TEXT NOT NULL,
        UNIQUE(user_id, character_id, character_instance_id, kind));
      CREATE TABLE IF NOT EXISTS companion_mode_operations(
        operation_id TEXT PRIMARY KEY,
        signature TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL);
    `);
  }

  get currentGeneration(): number {
    return this.generation;
  }

  get currentRunState(): CompanionRunState {
    return this.runState;
  }

  getPolicy(): CompanionModePolicy {
    const row = this.db.prepare(`
      SELECT * FROM companion_mode_policy
      WHERE user_id=? AND character_id=? AND character_instance_id=?
    `).get(this.pairing.userId, this.pairing.characterId, this.pairing.characterInstanceId) as Record<string, unknown> | undefined;

    if (!row) {
      // Default policy: passive mode, 5min observation, 20:00, Asia/Shanghai, revision 1
      return {
        schemaVersion: 1,
        revision: 1,
        pairing: this.pairing,
        mode: 'passive',
        observationIntervalMs: 300_000,
        dailyLocalTime: '20:00',
        timezone: 'Asia/Shanghai',
        policyVersion: 1,
      };
    }

    return {
      schemaVersion: 1,
      revision: Number(row.revision),
      pairing: this.pairing,
      mode: row.mode as CompanionMode,
      observationIntervalMs: Number(row.observation_interval_ms),
      dailyLocalTime: String(row.daily_local_time),
      timezone: String(row.timezone),
      policyVersion: Number(row.policy_version),
    };
  }

  /** Idempotent update of Companion Mode Policy. Does NOT issue or modify source grants. */
  async setPolicy(input: {
    readonly mode: CompanionMode;
    readonly observationIntervalMs: number;
    readonly dailyLocalTime: string;
    readonly timezone: string;
    readonly expectedRevision: number;
    readonly operationId: string;
  }): Promise<CompanionModePolicy> {
    return this.#idempotent(input.operationId, ['setPolicy', JSON.stringify(input)], async () => {
      const current = this.getPolicy();
      if (current.revision !== input.expectedRevision) {
        throw new CompanionModeError('version_conflict', 'Policy revision is stale.');
      }

      const next: CompanionModePolicy = {
        schemaVersion: 1,
        revision: current.revision + 1,
        pairing: this.pairing,
        mode: input.mode,
        observationIntervalMs: input.observationIntervalMs,
        dailyLocalTime: input.dailyLocalTime,
        timezone: input.timezone,
        policyVersion: current.policyVersion + 1,
      };
      validateCompanionModePolicy(next);

      this.db.prepare(`
        INSERT INTO companion_mode_policy(
          user_id, character_id, character_instance_id, mode, observation_interval_ms,
          daily_local_time, timezone, policy_version, revision, updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(user_id, character_id, character_instance_id) DO UPDATE SET
          mode=excluded.mode,
          observation_interval_ms=excluded.observation_interval_ms,
          daily_local_time=excluded.daily_local_time,
          timezone=excluded.timezone,
          policy_version=excluded.policy_version,
          revision=excluded.revision,
          updated_at=excluded.updated_at
      `).run(
        this.pairing.userId, this.pairing.characterId, this.pairing.characterInstanceId,
        next.mode, next.observationIntervalMs, next.dailyLocalTime, next.timezone,
        next.policyVersion, next.revision, this.now(),
      );

      // If switched from active to passive: bump generation to cancel active screen observations
      if (current.mode === 'active' && next.mode === 'passive') {
        this.#bumpGeneration();
      }

      return next;
    });
  }

  /** Pause all collection and observation tasks across all sources. */
  async pauseAll(reason: string, operationId: string = randomUUID()): Promise<ModeStatus> {
    return this.#idempotent(operationId, ['pauseAll', reason], async () => {
      this.runState = 'paused';
      this.#bumpGeneration();
      for (const kind of [...this.leases]) {
        this.leases.delete(kind);
        await this.onSourceSync?.(kind, false).catch(() => undefined);
      }
      return this.getStatus(reason);
    });
  }

  /** Resume collection and observation tasks for still-valid active grants. */
  async resume(operationId: string = randomUUID()): Promise<ModeStatus> {
    return this.#idempotent(operationId, ['resume'], async () => {
      this.runState = 'running';
      this.#bumpGeneration();
      const sources = this.listGrants();
      for (const source of sources) {
        if (source.state === 'active' && Date.parse(source.expiresAt) > Date.parse(this.now())) {
          this.leases.add(source.kind);
          await this.onSourceSync?.(source.kind, true).catch(() => {
            this.leases.delete(source.kind);
          });
        }
      }
      return this.getStatus();
    });
  }

  /** Handle OS session lock or system sleep: automatically pauses collection. */
  async onSessionLock(): Promise<void> {
    await this.pauseAll('session_locked');
  }

  /** Issue or re-authorize an individual source grant. */
  async activateSource(input: {
    readonly kind: CompanionSourceKind;
    readonly scope?: SourceGrantScope;
    readonly purposes?: readonly SourceGrantPurpose[];
    readonly destination?: SourceGrantDestination;
    readonly expiresAt: string;
    readonly expectedRevision: number;
    readonly operationId: string;
    readonly userConfirmed: boolean;
  }): Promise<SourceGrant> {
    if (!input.userConfirmed) {
      throw new CompanionModeError('forbidden', 'Explicit confirmation required to activate source.');
    }
    return this.#idempotent(input.operationId, ['activateSource', JSON.stringify(input)], async () => {
      const existing = this.getGrant(input.kind);
      if (!existing) {
        if (input.expectedRevision !== 0) {
          throw new CompanionModeError('version_conflict', 'expectedRevision must be 0 for new grant.');
        }
        const grant: SourceGrant = {
          schemaVersion: 1,
          grantId: randomUUID(),
          revision: 1,
          pairing: this.pairing,
          kind: input.kind,
          scope: input.scope ?? {},
          purposes: input.purposes ?? ['receive'],
          destination: input.destination ?? 'local',
          grantedAt: this.now(),
          expiresAt: input.expiresAt,
          profile: 'normal',
          state: 'active',
        };
        this.#insertGrant(grant);
        if (this.runState === 'running') {
          this.leases.add(input.kind);
          await this.onSourceSync?.(input.kind, true).catch(() => {
            this.leases.delete(input.kind);
          });
        }
        return grant;
      }

      if (existing.revision !== input.expectedRevision) {
        throw new CompanionModeError('version_conflict', 'Grant revision is stale.');
      }

      const nextGrant: SourceGrant = {
        ...existing,
        revision: existing.revision + 1,
        scope: input.scope ?? existing.scope,
        purposes: input.purposes ?? existing.purposes,
        destination: input.destination ?? existing.destination,
        expiresAt: input.expiresAt,
        state: 'active',
      };
      this.#updateGrant(nextGrant);
      if (this.runState === 'running') {
        this.leases.add(input.kind);
        await this.onSourceSync?.(input.kind, true).catch(() => {
          this.leases.delete(input.kind);
        });
      }
      return nextGrant;
    });
  }

  /** Transition single source grant (pause, resume, stop, revoke) without affecting other sources. */
  async transitionSource(input: {
    readonly kind: CompanionSourceKind;
    readonly action: 'pause' | 'resume' | 'stop' | 'revoke';
    readonly expectedRevision: number;
    readonly operationId: string;
  }): Promise<SourceGrant> {
    return this.#idempotent(input.operationId, ['transitionSource', JSON.stringify(input)], async () => {
      const existing = this.getGrant(input.kind);
      if (!existing) {
        throw new CompanionModeError('not_found', 'Source grant not found.');
      }
      if (existing.revision !== input.expectedRevision) {
        throw new CompanionModeError('version_conflict', 'Grant revision is stale.');
      }

      let nextState: SourceGrantState;
      switch (input.action) {
        case 'pause':
          nextState = 'paused';
          break;
        case 'resume':
          if (Date.parse(existing.expiresAt) <= Date.parse(this.now())) {
            throw new CompanionModeError('expired', 'Grant expired while paused.');
          }
          nextState = 'active';
          break;
        case 'stop':
          nextState = 'stopped';
          break;
        case 'revoke':
          nextState = 'revoked';
          break;
      }

      const nextGrant: SourceGrant = {
        ...existing,
        revision: existing.revision + 1,
        state: nextState,
      };
      this.#updateGrant(nextGrant);

      // Single source lease control: never call suspendAll here!
      if (nextState === 'active' && this.runState === 'running') {
        this.leases.add(input.kind);
        await this.onSourceSync?.(input.kind, true).catch(() => {
          this.leases.delete(input.kind);
        });
      } else {
        this.leases.delete(input.kind);
        await this.onSourceSync?.(input.kind, false).catch(() => undefined);
      }

      return nextGrant;
    });
  }

  getGrant(kind: CompanionSourceKind): SourceGrant | null {
    const row = this.db.prepare(`
      SELECT * FROM companion_mode_grants
      WHERE user_id=? AND character_id=? AND character_instance_id=? AND kind=?
    `).get(this.pairing.userId, this.pairing.characterId, this.pairing.characterInstanceId, kind) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.#rowToGrant(row);
  }

  listGrants(): readonly SourceGrant[] {
    const rows = this.db.prepare(`
      SELECT * FROM companion_mode_grants
      WHERE user_id=? AND character_id=? AND character_instance_id=?
    `).all(this.pairing.userId, this.pairing.characterId, this.pairing.characterInstanceId) as Record<string, unknown>[];
    return rows.map(r => this.#rowToGrant(r));
  }

  getStatus(reasonCode: string | null = null): ModeStatus {
    const policy = this.getPolicy();
    const grants = this.listGrants();
    const effectiveSources = grants.map(grant => ({
      kind: grant.kind,
      state: grant.state,
      hasLease: this.leases.has(grant.kind),
      lastSuccessAt: null,
      lastErrorCode: null,
    }));

    return {
      policy,
      runState: this.runState,
      generation: this.generation,
      reasonCode,
      effectiveSources,
      observationState: {
        lastRunAt: null,
        nextRunAt: null,
        activeJobId: null,
      },
      batchState: {
        lastSuccessDay: null,
        activeJobId: null,
      },
    };
  }

  #bumpGeneration(): void {
    this.generation++;
    this.onGenerationChange?.(this.generation);
  }

  #insertGrant(grant: SourceGrant): void {
    this.db.prepare(`
      INSERT INTO companion_mode_grants(
        grant_id, user_id, character_id, character_instance_id, kind,
        scope_json, purposes_json, destination, profile, state,
        revision, granted_at, expires_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      grant.grantId, this.pairing.userId, this.pairing.characterId, this.pairing.characterInstanceId,
      grant.kind, JSON.stringify(grant.scope), JSON.stringify(grant.purposes),
      grant.destination, grant.profile, grant.state, grant.revision,
      grant.grantedAt, grant.expiresAt,
    );
  }

  #updateGrant(grant: SourceGrant): void {
    this.db.prepare(`
      UPDATE companion_mode_grants SET
        scope_json=?, purposes_json=?, destination=?, profile=?, state=?,
        revision=?, expires_at=?
      WHERE grant_id=? AND user_id=? AND character_id=? AND character_instance_id=?
    `).run(
      JSON.stringify(grant.scope), JSON.stringify(grant.purposes),
      grant.destination, grant.profile, grant.state, grant.revision,
      grant.expiresAt, grant.grantId, this.pairing.userId, this.pairing.characterId, this.pairing.characterInstanceId,
    );
  }

  #rowToGrant(row: Record<string, unknown>): SourceGrant {
    return {
      schemaVersion: 1,
      grantId: String(row.grant_id),
      revision: Number(row.revision),
      pairing: this.pairing,
      kind: row.kind as CompanionSourceKind,
      scope: JSON.parse(String(row.scope_json)) as SourceGrantScope,
      purposes: JSON.parse(String(row.purposes_json)) as SourceGrantPurpose[],
      destination: row.destination as SourceGrantDestination,
      profile: row.profile as 'normal' | 'smoke',
      state: row.state as SourceGrantState,
      grantedAt: String(row.granted_at),
      expiresAt: String(row.expires_at),
    };
  }

  async #idempotent<T>(operationId: string, signatureParts: readonly string[], act: () => Promise<T>): Promise<T> {
    const signature = signatureParts.join('\u0000');
    const existing = this.db.prepare('SELECT signature, result_json FROM companion_mode_operations WHERE operation_id=?').get(operationId) as { signature: string; result_json: string } | undefined;
    if (existing) {
      if (existing.signature !== signature) {
        throw new CompanionModeError('invalid_request', 'Operation ID reused with conflicting body.');
      }
      return JSON.parse(existing.result_json) as T;
    }
    const result = await act();
    this.db.prepare('INSERT INTO companion_mode_operations(operation_id, signature, result_json, created_at) VALUES(?,?,?,?)')
      .run(operationId, signature, JSON.stringify(result), this.now());
    return result;
  }
}
