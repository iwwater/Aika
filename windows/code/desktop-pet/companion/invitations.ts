import type Database from 'better-sqlite3';
import type { CharacterId, InvitationPolicy, ProactiveInvitation, TurnScope } from '../contracts/index.js';
import type { MemoryRecord } from '../memory/ledger.js';
import { assertCharacter, bindScope, timestamp } from '../memory/scope.js';

export const confirmedInvitationPolicy = (timezone: string): InvitationPolicy => ({ quotaScope: 'all_characters', dailyMax: 2, minIntervalMs: 3 * 60 * 60 * 1000, timezone });
export interface InvitationCandidate {
  readonly id: string; readonly eventId: string; readonly text: string; readonly gesture: string;
  readonly eligibleAt: string; readonly expiresAt: string;
}
interface InvitationRow {
  character_id: CharacterId; id: string; event_id: string; event_version: number; text: string; gesture: string;
  eligible_at: string; expires_at: string; status: ProactiveInvitation['status'];
}
export interface VoiceInvitationIntent { readonly type: 'start_voice'; readonly scope: TurnScope; readonly invitationId: string; readonly eventId: string; readonly sourceVersion: number }
export interface InvitationAcceptance { readonly type: 'start_voice'; readonly invitationId: string; readonly eventId: string; readonly sourceVersion: number }
export interface InvitationDismissal { readonly invitationId: string; readonly eventId: string; readonly sourceVersion: number }
const policyKey = 'invitation_policy';

/** No media dependencies: showing an invitation can only return text/gesture; voice requires click(). */
export class InvitationStore {
  constructor(private readonly db: Database.Database, initialPolicy: InvitationPolicy, private readonly clock: () => string,
    private readonly memory: (role: CharacterId, id: string) => MemoryRecord | null) {
    this.#validatePolicy(initialPolicy);
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS companion_invitations(character_id TEXT NOT NULL REFERENCES characters(character_id), id TEXT NOT NULL,
          event_id TEXT NOT NULL, event_version INTEGER NOT NULL, text TEXT NOT NULL, gesture TEXT NOT NULL, eligible_at TEXT NOT NULL,
          eligible_ms INTEGER NOT NULL, expires_at TEXT NOT NULL, expires_ms INTEGER NOT NULL, status TEXT NOT NULL, PRIMARY KEY(character_id,id),
          FOREIGN KEY(character_id,event_id) REFERENCES memory_records(character_id,id));
        CREATE TABLE IF NOT EXISTS invitation_deliveries(id INTEGER PRIMARY KEY,character_id TEXT NOT NULL,invitation_id TEXT NOT NULL,event_id TEXT NOT NULL,shown_ms INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS delivery_time ON invitation_deliveries(shown_ms);
        CREATE TABLE IF NOT EXISTS invitation_ignored(character_id TEXT NOT NULL,event_id TEXT NOT NULL,local_day TEXT NOT NULL,PRIMARY KEY(character_id,event_id,local_day));
        CREATE TRIGGER IF NOT EXISTS invalidate_memory_invitations AFTER UPDATE ON memory_records
          WHEN new.kind='memory' AND (new.state!='active' OR new.version!=old.version) BEGIN
            UPDATE companion_invitations SET status='expired',text='',gesture='' WHERE character_id=new.character_id AND event_id=new.id AND status!='expired'; END;
      `);
      const existing = db.prepare('SELECT value FROM app_settings WHERE key=?').get(policyKey) as {value: string} | undefined;
      if (existing && !this.#samePolicy(JSON.parse(existing.value), initialPolicy)) throw new Error('invitation_configuration_mismatch');
      db.prepare('INSERT OR IGNORE INTO app_settings(key,value) VALUES(?,?)').run(policyKey, JSON.stringify(initialPolicy));
      this.#expire(timestamp(clock()));
    }).immediate();
  }
  #samePolicy(a: InvitationPolicy, b: InvitationPolicy): boolean {
    return a.quotaScope === b.quotaScope && a.dailyMax === b.dailyMax && a.minIntervalMs === b.minIntervalMs && a.timezone === b.timezone;
  }
  #validatePolicy(policy: InvitationPolicy): void {
    if (policy.quotaScope !== 'all_characters' || !Number.isSafeInteger(policy.dailyMax) || policy.dailyMax < 0 || !Number.isSafeInteger(policy.minIntervalMs) || policy.minIntervalMs < 0 || typeof policy.timezone !== 'string' || !policy.timezone.trim()) throw new Error('invalid_invitation_policy');
    new Intl.DateTimeFormat('en', { timeZone: policy.timezone }).format(0);
  }
  policy(): InvitationPolicy { return JSON.parse((this.db.prepare('SELECT value FROM app_settings WHERE key=?').get(policyKey) as {value: string}).value); }
  configure(policy: InvitationPolicy): void {
    this.#validatePolicy(policy);
    this.db.transaction(() => this.db.prepare('UPDATE app_settings SET value=? WHERE key=?').run(JSON.stringify(policy), policyKey)).immediate();
  }
  #day(at: number, timezone: string): string {
    const parts = new Intl.DateTimeFormat('en', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at);
    const part = (kind: string) => parts.find(item => item.type === kind)!.value;
    return `${part('year')}-${part('month')}-${part('day')}`;
  }
  #expire(now: number): void {
    this.db.prepare("UPDATE companion_invitations SET status='expired',text='',gesture='' WHERE expires_ms<=? AND status!='expired'").run(now);
  }
  #decode(row: InvitationRow): ProactiveInvitation {
    return { characterId: row.character_id, id: row.id, eventId: row.event_id, text: row.text, gesture: row.gesture,
      eligibleAt: row.eligible_at, expiresAt: row.expires_at, status: row.status };
  }
  #valid(row: InvitationRow): boolean {
    const source = this.memory(row.character_id, row.event_id);
    return !!source && source.kind === 'memory' && source.state === 'active' && source.version === row.event_version;
  }
  #shown(characterId: CharacterId, now: number): ProactiveInvitation | null {
    this.#expire(now);
    const rows = this.db.prepare("SELECT * FROM companion_invitations WHERE character_id=? AND status='shown' ORDER BY rowid")
      .all(characterId) as InvitationRow[];
    for (const row of rows) {
      if (!this.#valid(row)) {
        this.db.prepare("UPDATE companion_invitations SET status='expired',text='',gesture='' WHERE character_id=? AND id=?")
          .run(characterId, row.id);
        continue;
      }
      return this.#decode(row);
    }
    return null;
  }
  /** Returns the still-current visible card so a restarted backend can restore it without spending quota again. */
  shownForCharacter(characterId: CharacterId): ProactiveInvitation | null {
    assertCharacter(characterId);
    return this.db.transaction(() => this.#shown(characterId, timestamp(this.clock()))).immediate();
  }
  register(scope: TurnScope, candidate: InvitationCandidate): ProactiveInvitation {
    bindScope(scope, scope.characterId);
    if (!candidate.id || !candidate.text.trim() || !candidate.gesture.trim() || timestamp(candidate.eligibleAt) >= timestamp(candidate.expiresAt)) throw new Error('invalid_invitation');
    return this.db.transaction(() => {
      const source = this.memory(scope.characterId, candidate.eventId);
      if (!source || source.kind !== 'memory' || source.state !== 'active') throw new Error('invitation_requires_active_role_event');
      this.db.prepare(`INSERT INTO companion_invitations(character_id,id,event_id,event_version,text,gesture,eligible_at,eligible_ms,expires_at,expires_ms,status)
        VALUES(?,?,?,?,?,?,?,?,?,?,'eligible')`).run(scope.characterId, candidate.id, candidate.eventId, source.version, candidate.text, candidate.gesture, candidate.eligibleAt, timestamp(candidate.eligibleAt), candidate.expiresAt, timestamp(candidate.expiresAt));
      return { characterId: scope.characterId, ...candidate, status: 'eligible' as const };
    }).immediate();
  }
  inspect(scope: TurnScope, id: string): ProactiveInvitation | null {
    bindScope(scope, scope.characterId);
    return this.db.transaction(() => {
      this.#expire(timestamp(this.clock()));
      const row = this.db.prepare('SELECT * FROM companion_invitations WHERE character_id=? AND id=?').get(scope.characterId, id) as InvitationRow | undefined;
      return row ? this.#decode(row) : null;
    }).immediate();
  }
  showNext(activeScope: TurnScope): ProactiveInvitation | null {
    const scope = bindScope(activeScope, activeScope.characterId);
    return this.db.transaction(() => {
      const now = timestamp(this.clock()); const policy = this.policy();
      const alreadyShown = this.#shown(scope.characterId, now);
      if (alreadyShown) return alreadyShown;
      const last = this.db.prepare('SELECT max(shown_ms) AS at FROM invitation_deliveries').get() as {at: number | null};
      if (last.at !== null && now - last.at < policy.minIntervalMs) return null;
      const day = this.#day(now, policy.timezone);
      // Only timestamps are read globally. Event text and candidates remain role-scoped.
      const deliveries = this.db.prepare('SELECT shown_ms FROM invitation_deliveries WHERE shown_ms>=?').all(now - 48 * 60 * 60 * 1000) as {shown_ms: number}[];
      if (deliveries.filter(row => this.#day(row.shown_ms, policy.timezone) === day).length >= policy.dailyMax) return null;
      const candidates = this.db.prepare("SELECT * FROM companion_invitations WHERE character_id=? AND status='eligible' AND eligible_ms<=? AND expires_ms>? ORDER BY eligible_ms,rowid").all(scope.characterId, now, now) as InvitationRow[];
      for (const row of candidates) {
        if (!this.#valid(row)) {
          this.db.prepare("UPDATE companion_invitations SET status='expired',text='',gesture='' WHERE character_id=? AND id=?").run(scope.characterId, row.id); continue;
        }
        if (this.db.prepare('SELECT 1 FROM invitation_ignored WHERE character_id=? AND event_id=? AND local_day=?').get(scope.characterId, row.event_id, day)) continue;
        this.db.prepare("UPDATE companion_invitations SET status='shown' WHERE character_id=? AND id=?").run(scope.characterId, row.id);
        this.db.prepare('INSERT INTO invitation_deliveries(character_id,invitation_id,event_id,shown_ms) VALUES(?,?,?,?)').run(scope.characterId, row.id, row.event_id, now);
        return this.#decode({ ...row, status: 'shown' });
      }
      return null;
    }).immediate();
  }
  ignore(activeScope: TurnScope, id: string): boolean {
    const scope = bindScope(activeScope, activeScope.characterId);
    return this.#consumeIgnore(scope.characterId, id) !== null;
  }
  /** Product entry point for an explicit "later" action from the renderer. */
  ignoreForCharacter(characterId: CharacterId, id: string): InvitationDismissal | null {
    assertCharacter(characterId);
    return this.#consumeIgnore(characterId, id);
  }
  #consumeIgnore(characterId: CharacterId, id: string): InvitationDismissal | null {
    return this.db.transaction(() => {
      const now = timestamp(this.clock()); this.#expire(now);
      const row = this.db.prepare('SELECT * FROM companion_invitations WHERE character_id=? AND id=?').get(characterId, id) as InvitationRow | undefined;
      if (!row || row.status !== 'shown' || !this.#valid(row)) return null;
      this.db.prepare("UPDATE companion_invitations SET status='ignored' WHERE character_id=? AND id=?").run(characterId, id);
      this.db.prepare('INSERT OR IGNORE INTO invitation_ignored(character_id,event_id,local_day) VALUES(?,?,?)')
        .run(characterId, row.event_id, this.#day(now, this.policy().timezone));
      return { invitationId: row.id, eventId: row.event_id, sourceVersion: row.event_version };
    }).immediate();
  }
  click(activeScope: TurnScope, id: string): VoiceInvitationIntent | null {
    const scope = bindScope(activeScope, activeScope.characterId);
    const intent = this.#consumeClick(scope.characterId, id);
    return intent ? { ...intent, scope } : null;
  }
  /** Product entry point for a user click; it returns no invented dialogue TurnScope. */
  clickForCharacter(characterId: CharacterId, id: string): InvitationAcceptance | null {
    assertCharacter(characterId);
    return this.#consumeClick(characterId, id);
  }
  #consumeClick(characterId: CharacterId, id: string): InvitationAcceptance | null {
    return this.db.transaction(() => {
      this.#expire(timestamp(this.clock()));
      const row = this.db.prepare('SELECT * FROM companion_invitations WHERE character_id=? AND id=?').get(characterId, id) as InvitationRow | undefined;
      if (!row || row.status !== 'shown' || !this.#valid(row)) return null;
      this.db.prepare("UPDATE companion_invitations SET status='clicked' WHERE character_id=? AND id=?").run(characterId, id);
      return { type: 'start_voice' as const, invitationId: id, eventId: row.event_id, sourceVersion: row.event_version };
    }).immediate();
  }
}
