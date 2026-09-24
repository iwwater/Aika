import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { CharacterId, ProactiveInvitation } from '../contracts/index.js';
import type { PairingScope } from '../contracts/character-pack.js';
import type { ContinuityFact, ContinuityMemoryPort } from '../contracts/continuity-memory.js';
import type { CompanionEventHub } from '../core/companion-event-hub.js';
import type { UserBusyState } from '../core/proactive-companion.js';
import type { InvitationStore } from './invitations.js';

export interface ProactiveInvitationPolicy {
  readonly revision: number;
  readonly enabled: boolean;
  readonly dailyMax: number;
  readonly minIntervalMs: number;
  readonly timezone: string;
  readonly dndStartHour: number;
  readonly dndEndHour: number;
  readonly sourceKinds: readonly ['continuity_fact'];
}

export interface ProactiveInvitationAcceptance {
  readonly type: 'submit_text';
  readonly text: string;
  readonly invitationId: string;
  readonly eventId: string;
  readonly sourceVersion: number;
}
export interface ProactiveInvitationDismissal {
  readonly invitationId: string;
  readonly eventId: string;
  readonly sourceVersion: number;
}

interface CandidateRow {
  user_id: string; character_id: CharacterId; instance_id: string; id: string;
  source_id: string; source_version: number; text: string; response_text: string;
  created_at: string; eligible_at: string; eligible_ms: number; expires_at: string; expires_ms: number;
  status: ProactiveInvitation['status'];
}
interface PolicyRow {
  revision: number; enabled: number; daily_max: number; min_interval_ms: number; timezone: string;
  dnd_start_hour: number; dnd_end_hour: number;
}
interface CursorRow { revision: number }

const defaultPolicy = (timezone: string): Omit<ProactiveInvitationPolicy, 'revision'> => ({
  enabled: false, dailyMax: 2, minIntervalMs: 3 * 60 * 60 * 1000, timezone,
  dndStartHour: 22, dndEndHour: 8, sourceKinds: ['continuity_fact'],
});
const pairArgs = (pairing: PairingScope) => [pairing.userId, pairing.characterId, pairing.characterInstanceId] as const;
const localParts = (now: number, timezone: string) => {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false }).formatToParts(now);
  const get = (kind: string) => parts.find(part => part.type === kind)?.value ?? '00';
  return { day: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) };
};
const invitationId = (pairing: PairingScope, fact: ContinuityFact): string => 'proactive-' + createHash('sha256')
  .update(JSON.stringify([pairing.userId, pairing.characterId, pairing.characterInstanceId, fact.id, fact.version])).digest('hex').slice(0, 40);

/** Durable continuity-fact invitation path. It is opt-in, text-only and never exposes fact text. */
export class ProactiveInvitationRuntime {
  constructor(
    private readonly db: Database.Database,
    private readonly continuity: ContinuityMemoryPort,
    private readonly legacyInvitations: InvitationStore,
    private readonly hub: CompanionEventHub,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS proactive_invitation_policy (
        user_id TEXT NOT NULL, character_id TEXT NOT NULL, instance_id TEXT NOT NULL,
        revision INTEGER NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
        daily_max INTEGER NOT NULL, min_interval_ms INTEGER NOT NULL, timezone TEXT NOT NULL,
        dnd_start_hour INTEGER NOT NULL, dnd_end_hour INTEGER NOT NULL,
        PRIMARY KEY(user_id,character_id,instance_id)
      );
      CREATE TABLE IF NOT EXISTS proactive_invitation_cursor (
        user_id TEXT NOT NULL, character_id TEXT NOT NULL, instance_id TEXT NOT NULL, revision INTEGER NOT NULL,
        PRIMARY KEY(user_id,character_id,instance_id)
      );
      CREATE TABLE IF NOT EXISTS proactive_invitation_candidates (
        user_id TEXT NOT NULL, character_id TEXT NOT NULL, instance_id TEXT NOT NULL,
        id TEXT NOT NULL, source_id TEXT NOT NULL, source_version INTEGER NOT NULL,
        text TEXT NOT NULL, response_text TEXT NOT NULL, created_at TEXT NOT NULL,
        eligible_at TEXT NOT NULL, eligible_ms INTEGER NOT NULL, expires_at TEXT NOT NULL, expires_ms INTEGER NOT NULL,
        status TEXT NOT NULL, PRIMARY KEY(user_id,character_id,instance_id,id),
        UNIQUE(user_id,character_id,instance_id,source_id,source_version)
      );
      CREATE INDEX IF NOT EXISTS proactive_candidates_ready
        ON proactive_invitation_candidates(user_id,character_id,instance_id,status,eligible_ms,expires_ms);
    `);
  }

  policy(pairing: PairingScope): ProactiveInvitationPolicy {
    const legacy = this.legacyInvitations.policy();
    const initial = defaultPolicy(legacy.timezone);
    this.db.prepare(`INSERT OR IGNORE INTO proactive_invitation_policy
      (user_id,character_id,instance_id,revision,enabled,daily_max,min_interval_ms,timezone,dnd_start_hour,dnd_end_hour)
      VALUES(?,?,?,0,?,?,?,?,?,?)`).run(...pairArgs(pairing), initial.enabled ? 1 : 0, initial.dailyMax,
      initial.minIntervalMs, initial.timezone, initial.dndStartHour, initial.dndEndHour);
    const row = this.db.prepare('SELECT * FROM proactive_invitation_policy WHERE user_id=? AND character_id=? AND instance_id=?')
      .get(...pairArgs(pairing)) as PolicyRow;
    return Object.freeze({ revision: row.revision, enabled: row.enabled === 1, dailyMax: row.daily_max,
      minIntervalMs: row.min_interval_ms, timezone: row.timezone, dndStartHour: row.dnd_start_hour,
      dndEndHour: row.dnd_end_hour, sourceKinds: Object.freeze(['continuity_fact'] as const) });
  }

  configure(pairing: PairingScope, expectedRevision: number, update: Omit<ProactiveInvitationPolicy, 'revision'>): ProactiveInvitationPolicy {
    const old = this.policy(pairing);
    if (!Number.isSafeInteger(expectedRevision) || old.revision !== expectedRevision) throw new Error('proactive_policy_revision_conflict');
    const legacy = this.legacyInvitations.policy();
    if (typeof update.enabled !== 'boolean' || !Number.isSafeInteger(update.dailyMax) || update.dailyMax < 0
      || update.dailyMax > legacy.dailyMax || !Number.isSafeInteger(update.minIntervalMs) || update.minIntervalMs < legacy.minIntervalMs
      || update.timezone !== legacy.timezone || !Number.isSafeInteger(update.dndStartHour) || update.dndStartHour < 0 || update.dndStartHour > 23
      || !Number.isSafeInteger(update.dndEndHour) || update.dndEndHour < 0 || update.dndEndHour > 23
      || !Array.isArray(update.sourceKinds) || update.sourceKinds.length !== 1 || update.sourceKinds[0] !== 'continuity_fact') {
      throw new Error('invalid_proactive_policy');
    }
    try { new Intl.DateTimeFormat('en-US', { timeZone: update.timezone }).format(0); } catch { throw new Error('invalid_proactive_policy'); }
    this.db.transaction(() => {
      const revision = old.revision + 1;
      this.db.prepare(`UPDATE proactive_invitation_policy SET revision=?,enabled=?,daily_max=?,min_interval_ms=?,timezone=?,dnd_start_hour=?,dnd_end_hour=?
        WHERE user_id=? AND character_id=? AND instance_id=?`).run(revision, update.enabled ? 1 : 0, update.dailyMax,
        update.minIntervalMs, update.timezone, update.dndStartHour, update.dndEndHour, ...pairArgs(pairing));
      const snapshot = this.continuity.snapshot(pairing);
      if (!old.enabled && update.enabled || old.enabled && !update.enabled) {
        this.db.prepare(`INSERT INTO proactive_invitation_cursor(user_id,character_id,instance_id,revision) VALUES(?,?,?,?)
          ON CONFLICT(user_id,character_id,instance_id) DO UPDATE SET revision=excluded.revision`).run(...pairArgs(pairing), snapshot.revision);
      }
      if (!update.enabled) this.#expirePair(pairing);
    }).immediate();
    return this.policy(pairing);
  }

  /** Idempotent revision cursor recovers a crash between continuity commit and candidate staging. */
  sync(pairing: PairingScope): number {
    const policy = this.policy(pairing);
    const snapshot = this.continuity.snapshot(pairing);
    if (!policy.enabled) return 0;
    return this.db.transaction(() => {
      const current = this.db.prepare('SELECT revision FROM proactive_invitation_cursor WHERE user_id=? AND character_id=? AND instance_id=?')
        .get(...pairArgs(pairing)) as CursorRow | undefined;
      if (!current) {
        this.db.prepare('INSERT INTO proactive_invitation_cursor(user_id,character_id,instance_id,revision) VALUES(?,?,?,?)')
          .run(...pairArgs(pairing), snapshot.revision);
        return 0;
      }
      let inserted = 0;
      const now = Date.parse(this.clock());
      const createdAt = new Date(now).toISOString();
      const eligibleAt = new Date(now + 30_000).toISOString();
      const expiresAt = new Date(now + 15 * 60 * 1000).toISOString();
      const facts = [...snapshot.soul, ...snapshot.wiki, ...snapshot.relationship]
        .filter(fact => fact.status === 'active' && fact.evidenceEligible && fact.revision > current.revision
          && (fact.kind === 'fact' || fact.kind === 'milestone'))
        .sort((a, b) => a.revision - b.revision || a.id.localeCompare(b.id));
      for (const fact of facts) {
        const id = invitationId(pairing, fact);
        const result = this.db.prepare(`INSERT OR IGNORE INTO proactive_invitation_candidates
          (user_id,character_id,instance_id,id,source_id,source_version,text,response_text,created_at,eligible_at,eligible_ms,expires_at,expires_ms,status)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'eligible')`).run(...pairArgs(pairing), id, fact.id, fact.version,
          '想继续聊聊你之前整理的一个重要节点吗？', '我想继续聊聊之前整理的重要节点。', createdAt, eligibleAt, now + 30_000, expiresAt, now + 15 * 60 * 1000);
        inserted += result.changes;
      }
      this.db.prepare(`UPDATE proactive_invitation_cursor SET revision=? WHERE user_id=? AND character_id=? AND instance_id=?`)
        .run(snapshot.revision, ...pairArgs(pairing));
      this.#expireInvalid(pairing);
      return inserted;
    }).immediate();
  }

  showNext(pairing: PairingScope, busy: UserBusyState): ProactiveInvitation | null {
    const policy = this.policy(pairing);
    if (!policy.enabled || busy.isTyping || busy.isSpeaking || busy.isTurnActive || busy.isWorkPendingConfirmation) return null;
    const now = Date.parse(this.clock());
    if (!Number.isFinite(now) || this.#dnd(now, policy)) return null;
    const base = this.legacyInvitations.policy();
    const dailyMax = Math.min(policy.dailyMax, base.dailyMax);
    const minIntervalMs = Math.max(policy.minIntervalMs, base.minIntervalMs);
    const local = localParts(now, policy.timezone);
    const deliveries = this.db.prepare('SELECT shown_ms FROM invitation_deliveries WHERE shown_ms>=?').all(now - 48 * 60 * 60 * 1000) as { shown_ms: number }[];
    if (deliveries.some(row => now - row.shown_ms < minIntervalMs)
      || deliveries.filter(row => localParts(row.shown_ms, policy.timezone).day === local.day).length >= dailyMax) return null;
    this.#expireInvalid(pairing);
    return this.db.transaction(() => {
      const existing = this.db.prepare(`SELECT * FROM proactive_invitation_candidates WHERE user_id=? AND character_id=? AND instance_id=? AND status='shown' ORDER BY rowid LIMIT 1`)
        .get(...pairArgs(pairing)) as CandidateRow | undefined;
      if (existing) return null;
      const candidates = this.db.prepare(`SELECT * FROM proactive_invitation_candidates WHERE user_id=? AND character_id=? AND instance_id=?
        AND status='eligible' AND eligible_ms<=? AND expires_ms>? ORDER BY eligible_ms,rowid`).all(...pairArgs(pairing), now, now) as CandidateRow[];
      for (const row of candidates) {
        if (!this.#sourceValid(pairing, row.source_id, row.source_version)) { this.#expireRow(row, pairing); continue; }
        const day = local.day;
        if (this.db.prepare('SELECT 1 FROM invitation_ignored WHERE character_id=? AND event_id=? AND local_day=?').get(pairing.characterId, row.source_id, day)) continue;
        this.db.prepare("UPDATE proactive_invitation_candidates SET status='shown' WHERE user_id=? AND character_id=? AND instance_id=? AND id=? AND status='eligible'")
          .run(...pairArgs(pairing), row.id);
        this.db.prepare('INSERT INTO invitation_deliveries(character_id,invitation_id,event_id,shown_ms) VALUES(?,?,?,?)')
          .run(pairing.characterId, row.id, row.source_id, now);
        const shown = { ...row, status: 'shown' as const };
        this.#audit(pairing, shown, 'companion.invitation.presented');
        return this.#decode(shown);
      }
      return null;
    }).immediate();
  }

  shown(pairing: PairingScope): ProactiveInvitation | null {
    this.#expireInvalid(pairing);
    const row = this.db.prepare(`SELECT * FROM proactive_invitation_candidates WHERE user_id=? AND character_id=? AND instance_id=? AND status='shown' ORDER BY rowid LIMIT 1`)
      .get(...pairArgs(pairing)) as CandidateRow | undefined;
    return row ? this.#decode(row) : null;
  }

  accept(pairing: PairingScope, id: string): ProactiveInvitationAcceptance | null {
    return this.db.transaction(() => {
      const row = this.#candidate(pairing, id);
      if (!row || row.status !== 'shown') return null;
      if (row.expires_ms <= Date.parse(this.clock())) { this.#expireRow(row, pairing); return null; }
      if (!this.#sourceValid(pairing, row.source_id, row.source_version)) { this.#expireRow(row, pairing); return null; }
      this.db.prepare("UPDATE proactive_invitation_candidates SET status='clicked' WHERE user_id=? AND character_id=? AND instance_id=? AND id=?")
        .run(...pairArgs(pairing), id);
      this.#audit(pairing, row, 'companion.invitation.accepted');
      return { type: 'submit_text' as const, text: row.response_text, invitationId: row.id, eventId: row.source_id, sourceVersion: row.source_version };
    }).immediate();
  }

  ignore(pairing: PairingScope, id: string): ProactiveInvitationDismissal | null {
    return this.db.transaction(() => {
      const row = this.#candidate(pairing, id);
      if (!row || row.status !== 'shown') return null;
      if (row.expires_ms <= Date.parse(this.clock())) { this.#expireRow(row, pairing); return null; }
      if (!this.#sourceValid(pairing, row.source_id, row.source_version)) { this.#expireRow(row, pairing); return null; }
      this.db.prepare("UPDATE proactive_invitation_candidates SET status='ignored' WHERE user_id=? AND character_id=? AND instance_id=? AND id=?")
        .run(...pairArgs(pairing), id);
      const day = localParts(Date.parse(this.clock()), this.policy(pairing).timezone).day;
      this.db.prepare('INSERT OR IGNORE INTO invitation_ignored(character_id,event_id,local_day) VALUES(?,?,?)').run(pairing.characterId, row.source_id, day);
      this.#audit(pairing, row, 'companion.invitation.dismissed');
      return { invitationId: row.id, eventId: row.source_id, sourceVersion: row.source_version };
    }).immediate();
  }

  #candidate(pairing: PairingScope, id: string): CandidateRow | undefined {
    return this.db.prepare('SELECT * FROM proactive_invitation_candidates WHERE user_id=? AND character_id=? AND instance_id=? AND id=?')
      .get(...pairArgs(pairing), id) as CandidateRow | undefined;
  }
  #sourceValid(pairing: PairingScope, id: string, version: number): boolean {
    const snapshot = this.continuity.snapshot(pairing);
    return [...snapshot.soul, ...snapshot.wiki, ...snapshot.relationship].some(fact => fact.id === id && fact.version === version && fact.status === 'active');
  }
  #expireInvalid(pairing: PairingScope): void {
    const rows = this.db.prepare(`SELECT * FROM proactive_invitation_candidates WHERE user_id=? AND character_id=? AND instance_id=?
      AND status IN ('eligible','shown')`).all(...pairArgs(pairing)) as CandidateRow[];
    for (const row of rows) if (row.expires_ms <= Date.parse(this.clock()) || !this.#sourceValid(pairing, row.source_id, row.source_version)) this.#expireRow(row, pairing);
  }
  #expireRow(row: CandidateRow, pairing: PairingScope): void {
    if (row.status !== 'expired') this.#audit(pairing, row, 'companion.invitation.expired');
    this.db.prepare("UPDATE proactive_invitation_candidates SET status='expired',text='',response_text='' WHERE user_id=? AND character_id=? AND instance_id=? AND id=?")
      .run(row.user_id, row.character_id, row.instance_id, row.id);
  }
  #expirePair(pairing: PairingScope): void {
    const rows = this.db.prepare(`SELECT * FROM proactive_invitation_candidates WHERE user_id=? AND character_id=? AND instance_id=?
      AND status IN ('eligible','shown')`).all(...pairArgs(pairing)) as CandidateRow[];
    for (const row of rows) this.#expireRow(row, pairing);
  }
  #dnd(now: number, policy: ProactiveInvitationPolicy): boolean {
    const hour = localParts(now, policy.timezone).hour;
    return policy.dndStartHour <= policy.dndEndHour
      ? hour >= policy.dndStartHour && hour < policy.dndEndHour
      : hour >= policy.dndStartHour || hour < policy.dndEndHour;
  }
  #decode(row: CandidateRow): ProactiveInvitation {
    return Object.freeze({ characterId: row.character_id, id: row.id, eventId: row.source_id, sourceKind: 'continuity_fact',
      sourceVersion: row.source_version, actionKind: 'text', responseText: row.response_text, text: row.text,
      gesture: '继续聊聊', eligibleAt: row.eligible_at, expiresAt: row.expires_at, status: row.status });
  }
  #audit(pairing: PairingScope, row: CandidateRow, type: 'companion.invitation.presented' | 'companion.invitation.accepted' | 'companion.invitation.dismissed' | 'companion.invitation.expired'): void {
    const occurredAt = this.clock();
    const status = type.split('.').pop()!;
    try { this.hub.publishEnvelope({ schemaVersion: 1, eventId: `proactive-${row.id}-${type.split('.').pop()}`,
      domain: 'companion', type, pairing, sourceRef: { id: row.source_id, version: row.source_version }, occurredAt,
      receivedAt: occurredAt, payload: { invitationId: row.id, actionKind: 'text', status, sourceKind: 'continuity_fact' },
      summary: status === 'accepted' ? '接受了一条主动陪伴邀请' : status === 'dismissed' ? '暂不接受这条主动陪伴邀请'
        : status === 'expired' ? '主动陪伴邀请已过期' : '呈现了一条主动陪伴邀请' }); }
    catch { /* The durable candidate and delivery remain authoritative; outbox recovery handles projection. */ }
  }
}
