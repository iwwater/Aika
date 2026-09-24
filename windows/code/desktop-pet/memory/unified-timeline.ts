/**
 * memory/unified-timeline.ts
 *
 * 08-01: Cross-domain Unified Timeline Projection Service.
 * Implements querying and projection across Canon, Companion, and Work domains.
 *
 * Requirements:
 * - Domain isolation: Canon (lore), Companion (interaction), Work (task card).
 * - Idempotency: duplicate eventId deduplicated cleanly; conflict throws.
 * - Out-of-order resilience: sorted by occurredAt.
 * - Revocation & forget propagation: revoked source facts or deleted records dynamically excluded.
 * - Pairing isolation: strict tenant confinement.
 */

import type Database from 'better-sqlite3';
import type { CompanionEventEnvelope, EventDomain } from '../contracts/perception.js';
import type { PairingScope } from '../contracts/character-pack.js';
import type { CharacterPackStore } from './character-pack-store.js';

export interface TimelineItem {
  readonly eventId: string;
  readonly domain: EventDomain;
  readonly type: string;
  readonly occurredAt: string;
  readonly summary: string;
  readonly sourceRef: { readonly id: string; readonly version: number };
  readonly canonDetails?: { readonly awareness?: string; readonly scene?: string };
  readonly companionDetails?: { readonly userText: string; readonly assistantText: string; readonly sourceIds?: readonly string[] };
  readonly companionActivityDetails?: { readonly invitationId: string; readonly actionKind: 'text' | 'voice_start' | 'clarify'; readonly status: 'presented' | 'accepted' | 'dismissed' | 'expired'; readonly sourceKind?: 'memory' | 'continuity_fact' };
  readonly workDetails?: { readonly executorId: string; readonly status: string; readonly targetTitle: string; readonly instruction?: string; readonly resultSummary?: string };
}

export interface TimelineQuery {
  readonly pairing: PairingScope;
  readonly domains?: readonly EventDomain[];
  readonly limit?: number;
  readonly cursor?: string;
  readonly cutoffPoint?: string;
}

export interface TimelineQueryResult {
  readonly items: readonly TimelineItem[];
  readonly nextCursor: string | null;
  readonly totalMatching: number;
}

export interface WorkEventRow {
  event_id: string;
  user_id: string;
  character_id: string;
  character_instance_id: string;
  executor_id: string;
  task_id: string;
  status: string;
  title: string;
  instruction: string;
  occurred_at: string;
  result_summary: string;
  source_id: string;
  source_version: number;
}

export class UnifiedTimelineService {
  private readonly db: Database.Database;
  private readonly characterPacks: CharacterPackStore;

  constructor(db: Database.Database, characterPacks: CharacterPackStore) {
    this.db = db;
    this.characterPacks = characterPacks;
    this.initTables();
  }

  private initTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS companion_activity_timeline_events (
        event_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        character_id TEXT NOT NULL,
        character_instance_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        summary TEXT NOT NULL,
        source_id TEXT NOT NULL,
        source_version INTEGER NOT NULL,
        details_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_companion_activity_timeline
        ON companion_activity_timeline_events(user_id, character_id, character_instance_id, occurred_at);
      CREATE TABLE IF NOT EXISTS work_timeline_events (
        event_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        character_id TEXT NOT NULL,
        character_instance_id TEXT NOT NULL,
        executor_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        status TEXT NOT NULL,
        title TEXT NOT NULL,
        instruction TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        result_summary TEXT NOT NULL DEFAULT '',
        source_id TEXT NOT NULL,
        source_version INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_work_timeline 
        ON work_timeline_events(user_id, character_id, character_instance_id, occurred_at);
    `);
    // Work activity is a projection of an operation source. Revoke the source and scrub its
    // duplicated display text in the same SQLite owner so an old timeline row cannot retain it.
    const hasSourceRevocations = Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='character_source_revocations'").get());
    if (hasSourceRevocations) this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS work_timeline_source_redact_insert
      AFTER INSERT ON character_source_revocations
      WHEN new.target_type='source'
      BEGIN
        UPDATE work_timeline_events SET executor_id='forgotten',task_id='forgotten',title='已遗忘的工作任务',instruction='',result_summary=''
        WHERE character_id=new.character_id AND source_id=new.target_id;
      END;
      CREATE TRIGGER IF NOT EXISTS work_timeline_source_redact_update
      AFTER UPDATE OF reason,target_id,target_type ON character_source_revocations
      WHEN new.target_type='source'
      BEGIN
        UPDATE work_timeline_events SET executor_id='forgotten',task_id='forgotten',title='已遗忘的工作任务',instruction='',result_summary=''
        WHERE character_id=new.character_id AND source_id=new.target_id;
      END;
      UPDATE work_timeline_events SET executor_id='forgotten',task_id='forgotten',title='已遗忘的工作任务',instruction='',result_summary=''
      WHERE EXISTS (SELECT 1 FROM character_source_revocations r WHERE r.character_id=work_timeline_events.character_id
        AND r.target_type='source' AND r.target_id=work_timeline_events.source_id);
    `);
  }

  /**
   * Idempotently record an event from an envelope into its respective domain storage.
   */
  async recordEvent(envelope: CompanionEventEnvelope): Promise<'inserted' | 'duplicate' | 'ignored'> {
    return this.recordEventSync(envelope);
  }

  /** Synchronous storage path for durable outbox callbacks. The marker is deleted only after this commits. */
  recordEventSync(envelope: CompanionEventEnvelope): 'inserted' | 'duplicate' | 'ignored' {
    if (envelope.domain === 'companion') {
      if (envelope.type !== 'companion.turn.saved') {
        if (!['companion.invitation.presented', 'companion.invitation.accepted', 'companion.invitation.dismissed', 'companion.invitation.expired'].includes(envelope.type)) return 'ignored';
        const activityStatus = envelope.type === 'companion.invitation.presented' ? 'presented'
          : envelope.type === 'companion.invitation.accepted' ? 'accepted'
          : envelope.type === 'companion.invitation.dismissed' ? 'dismissed' : 'expired';
        const payload = envelope.payload as { invitationId?: unknown; actionKind?: unknown; status?: unknown; sourceKind?: unknown } | null;
        const actionKind = payload?.actionKind === 'start_voice' ? 'voice_start' : payload?.actionKind;
        const sourceKind = payload?.sourceKind === 'continuity_fact' ? 'continuity_fact' : 'memory';
        if (typeof payload?.invitationId !== 'string' || !payload.invitationId.trim()
          || typeof actionKind !== 'string' || !['text', 'voice_start', 'clarify'].includes(actionKind) || payload.status !== activityStatus
          || payload.sourceKind !== undefined && !['memory', 'continuity_fact'].includes(String(payload.sourceKind))
          || !envelope.sourceRef.id.trim() || !Number.isSafeInteger(envelope.sourceRef.version) || envelope.sourceRef.version < 1) {
          throw new Error('invalid_companion_invitation_event');
        }
        const details = { invitationId: payload.invitationId, actionKind: actionKind as 'text' | 'voice_start' | 'clarify', status: activityStatus,
          ...(payload.sourceKind === undefined ? {} : { sourceKind }) };
        const summary = activityStatus === 'presented' ? '呈现了一条主动陪伴邀请'
          : activityStatus === 'accepted' ? '接受了一条主动陪伴邀请'
          : activityStatus === 'expired' ? '主动陪伴邀请已过期' : '暂不接受这条主动陪伴邀请';
        const existing = this.db.prepare('SELECT * FROM companion_activity_timeline_events WHERE event_id=?').get(envelope.eventId) as {
          user_id: string; character_id: string; character_instance_id: string; event_type: string; occurred_at: string;
          summary: string; source_id: string; source_version: number; details_json: string;
        } | undefined;
        if (existing) {
          if (existing.user_id === envelope.pairing.userId && existing.character_id === envelope.pairing.characterId
            && existing.character_instance_id === envelope.pairing.characterInstanceId && existing.event_type === envelope.type
            && existing.occurred_at === envelope.occurredAt && existing.summary === summary
            && existing.source_id === envelope.sourceRef.id && existing.source_version === envelope.sourceRef.version
            && existing.details_json === JSON.stringify(details)) return 'duplicate';
          throw new Error(`Companion activity timeline conflict: event ${envelope.eventId} already exists with divergent payload`);
        }
        this.db.prepare(`INSERT INTO companion_activity_timeline_events
          (event_id,user_id,character_id,character_instance_id,event_type,occurred_at,summary,source_id,source_version,details_json)
          VALUES(?,?,?,?,?,?,?,?,?,?)`).run(envelope.eventId, envelope.pairing.userId, envelope.pairing.characterId,
          envelope.pairing.characterInstanceId, envelope.type, envelope.occurredAt, summary, envelope.sourceRef.id,
          envelope.sourceRef.version, JSON.stringify(details));
        return 'inserted';
      }
      const payload = envelope.payload as {
        userText?: string;
        assistantText?: string;
        sessionId?: string;
        turnId?: string;
        sourceIds?: readonly string[];
      };
      const userText = payload?.userText ?? envelope.summary ?? '';
      const assistantText = payload?.assistantText ?? '';
      const sessionId = payload?.sessionId ?? envelope.turnId ?? 'session-default';
      const turnId = payload?.turnId ?? envelope.turnId ?? envelope.eventId;

      const sourceIds = [...new Set(payload?.sourceIds ?? [envelope.sourceRef.id])];
      const existing = this.db.prepare('SELECT * FROM character_companion_timeline WHERE event_id=?').get(envelope.eventId) as {
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
      } | undefined;
      if (existing) {
        if (existing.user_id === envelope.pairing.userId
          && existing.character_id === envelope.pairing.characterId
          && existing.character_instance_id === envelope.pairing.characterInstanceId
          && existing.session_id === sessionId
          && existing.turn_id === turnId
          && existing.user_text === userText
          && existing.assistant_text === assistantText
          && existing.created_at === envelope.occurredAt
          && existing.source_ids_json === JSON.stringify(sourceIds)) return 'duplicate';
        throw new Error(`Companion timeline conflict: event ${envelope.eventId} already exists with divergent payload`);
      }
      this.characterPacks.appendCompanionEvent({
        eventId: envelope.eventId,
        userId: envelope.pairing.userId,
        characterId: envelope.pairing.characterId,
        characterInstanceId: envelope.pairing.characterInstanceId,
        sessionId,
        turnId,
        userText,
        assistantText,
        createdAt: envelope.occurredAt,
        sourceIds,
      });
      return 'inserted';
    }

    if (envelope.domain === 'work') {
      const payload = envelope.payload as {
        executorId?: string;
        taskId?: string;
        status?: string;
        title?: string;
        instruction?: string;
        resultSummary?: string;
      };
      const allowedStatuses = new Set(['prepared', 'dispatched', 'running', 'succeeded', 'failed', 'uncertain', 'cancelled']);
      if (typeof payload?.executorId !== 'string' || !payload.executorId.trim()) {
        throw new Error('invalid_work_event: executorId is required');
      }
      if (typeof payload?.status !== 'string' || !allowedStatuses.has(payload.status)) {
        throw new Error('invalid_work_event: a valid execution status is required');
      }
      const executorId = payload.executorId;
      const taskId = payload?.taskId ?? envelope.sourceRef.id;
      const status = payload.status;
      const title = payload?.title ?? envelope.summary ?? 'Work task';
      const instruction = payload?.instruction ?? '';
      const resultSummary = payload?.resultSummary ?? '';

      const existing = this.db.prepare('SELECT * FROM work_timeline_events WHERE event_id=?').get(envelope.eventId) as WorkEventRow | undefined;
      if (existing) {
        if (
          existing.user_id === envelope.pairing.userId &&
          existing.character_id === envelope.pairing.characterId &&
          existing.character_instance_id === envelope.pairing.characterInstanceId &&
          existing.executor_id === executorId &&
          existing.task_id === taskId &&
          existing.status === status &&
          existing.title === title &&
          existing.instruction === instruction &&
          existing.occurred_at === envelope.occurredAt
        ) {
          return 'duplicate';
        }
        throw new Error(`Work timeline conflict: event ${envelope.eventId} already exists with divergent payload`);
      }

      this.db.prepare(`
        INSERT INTO work_timeline_events
        (event_id, user_id, character_id, character_instance_id, executor_id, task_id, status, title, instruction, occurred_at, result_summary, source_id, source_version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        envelope.eventId,
        envelope.pairing.userId,
        envelope.pairing.characterId,
        envelope.pairing.characterInstanceId,
        executorId,
        taskId,
        status,
        title,
        instruction,
        envelope.occurredAt,
        resultSummary,
        envelope.sourceRef.id,
        envelope.sourceRef.version ?? 1,
      );
      return 'inserted';
    }

    // Canon domain events are pack-managed and immutable
    return 'inserted';
  }

  /**
   * Unified cross-domain query.
   */
  async queryTimeline(query: TimelineQuery): Promise<TimelineQueryResult> {
    const domains = new Set<EventDomain>(query.domains ?? ['canon', 'companion', 'work']);
    const limit = Math.max(1, Math.min(query.limit ?? 50, 200));
    const items: TimelineItem[] = [];

    // 1. Canon Domain (Lore from CharacterPack)
    if (domains.has('canon')) {
      const canonSnapshot = await this.characterPacks.getSnapshot(query.pairing, {
        cutoffPoint: query.cutoffPoint,
      });
      for (const ev of canonSnapshot.canonTimeline) {
        items.push({
          eventId: ev.eventId,
          domain: 'canon',
          type: 'canon.story.event',
          occurredAt: '2000-01-01T00:00:00.000Z',
          summary: ev.summary,
          sourceRef: { id: ev.eventId, version: 1 },
          canonDetails: {
            awareness: ev.awareness,
            ...(ev.chapter ? { scene: ev.chapter } : {}),
          },
        });
      }
    }

    // 2. Companion Domain (Interaction history from SQLite)
    if (domains.has('companion')) {
      const rows = this.db.prepare(`
        SELECT * FROM character_companion_timeline
        WHERE user_id=? AND character_id=? AND character_instance_id=?
        ORDER BY created_at ASC
      `).all(query.pairing.userId, query.pairing.characterId, query.pairing.characterInstanceId) as Array<{
        event_id: string;
        session_id: string;
        turn_id: string;
        user_text: string;
        assistant_text: string;
        created_at: string;
        source_ids_json: string;
      }>;

      for (const row of rows) {
        // Source revocation check: if text is empty (purged) or any source is revoked, exclude or mask
        let sourceIds: string[] = [];
        try { sourceIds = JSON.parse(row.source_ids_json); } catch {}
        const isRevoked = sourceIds.some(sourceId => this.characterPacks.isSourceRevoked(query.pairing.characterId, sourceId));
        if (isRevoked || (!row.user_text && !row.assistant_text)) {
          continue; // Revoked or forgotten content is omitted from unified timeline reads
        }

        items.push({
          eventId: row.event_id,
          domain: 'companion',
          type: 'companion.turn.saved',
          occurredAt: row.created_at,
          summary: row.user_text.slice(0, 40),
          sourceRef: { id: sourceIds[0] ?? row.turn_id, version: 1 },
          companionDetails: {
            userText: row.user_text,
            assistantText: row.assistant_text,
            sourceIds,
          },
        });
      }

      const activities = this.db.prepare(`SELECT * FROM companion_activity_timeline_events
        WHERE user_id=? AND character_id=? AND character_instance_id=?
        ORDER BY occurred_at ASC`).all(query.pairing.userId, query.pairing.characterId, query.pairing.characterInstanceId) as Array<{
          event_id: string; event_type: string; occurred_at: string; summary: string; source_id: string; source_version: number; details_json: string;
        }>;
      for (const row of activities) {
        let companionActivityDetails: TimelineItem['companionActivityDetails'];
        try { companionActivityDetails = JSON.parse(row.details_json) as TimelineItem['companionActivityDetails']; } catch { continue; }
        if (!companionActivityDetails) continue;
        // Activity sources are type-tagged so a continuity fact can never accidentally resolve
        // to an unrelated History row with the same opaque ID.
        if (companionActivityDetails.sourceKind === 'continuity_fact') {
          const source = this.db.prepare(`SELECT status,version FROM continuity_facts
            WHERE user_id=? AND character_id=? AND instance_id=? AND id=?`).get(query.pairing.userId, query.pairing.characterId,
            query.pairing.characterInstanceId, row.source_id) as { status: string; version: number } | undefined;
          if (!source || source.status !== 'active' || source.version !== row.source_version) continue;
        } else {
          // A source edit, forget, expiry, or purge hides the activity from the unified read.
          const source = this.db.prepare('SELECT state,version FROM memory_records WHERE character_id=? AND id=?').get(query.pairing.characterId, row.source_id) as {
            state: string; version: number;
          } | undefined;
          if (!source || source.state !== 'active' || source.version !== row.source_version) continue;
        }
        if (query.cutoffPoint && row.occurred_at > query.cutoffPoint) continue;
        items.push({
          eventId: row.event_id,
          domain: 'companion',
          type: row.event_type,
          occurredAt: row.occurred_at,
          summary: row.summary,
          sourceRef: { id: row.source_id, version: row.source_version },
          companionActivityDetails,
        });
      }
    }

    // 3. Work Domain (Task cards and ACP/MCP results)
    if (domains.has('work')) {
      const workRows = this.db.prepare(`
        SELECT * FROM work_timeline_events
        WHERE user_id=? AND character_id=? AND character_instance_id=?
        ORDER BY occurred_at ASC
      `).all(query.pairing.userId, query.pairing.characterId, query.pairing.characterInstanceId) as WorkEventRow[];

      for (const row of workRows) {
        // A Work sourceRef identifies the operation (normally its operationId).
        // Keep the durable audit row, but never expose content after that source is revoked/forgotten.
        if (this.characterPacks.isSourceRevoked(query.pairing.characterId, row.source_id)) continue;
        items.push({
          eventId: row.event_id,
          domain: 'work',
          type: 'work.task.receipt',
          occurredAt: row.occurred_at,
          summary: `[${row.executor_id}] ${row.title} (${row.status})`,
          sourceRef: { id: row.source_id, version: row.source_version },
          workDetails: {
            executorId: row.executor_id,
            status: row.status,
            targetTitle: row.title,
            instruction: row.instruction,
            ...(row.result_summary ? { resultSummary: row.result_summary } : {}),
          },
        });
      }
    }

    // Strict forward chronological sort by occurredAt
    items.sort((a, b) => {
      const ta = new Date(a.occurredAt).getTime();
      const tb = new Date(b.occurredAt).getTime();
      if (ta !== tb) return ta - tb;
      return a.eventId.localeCompare(b.eventId);
    });

    const totalMatching = items.length;
    let paginated = items;

    if (query.cursor) {
      const idx = items.findIndex(it => it.eventId === query.cursor);
      if (idx >= 0) {
        paginated = items.slice(idx + 1);
      }
    }

    const resultItems = paginated.slice(0, limit);
    const nextCursor = resultItems.length === limit && paginated.length > limit
      ? resultItems[resultItems.length - 1]!.eventId
      : null;

    return {
      items: resultItems,
      nextCursor,
      totalMatching,
    };
  }
}
