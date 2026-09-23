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
  readonly workDetails?: { readonly executorId: string; readonly status: string; readonly targetTitle: string; readonly instruction?: string };
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
  }

  /**
   * Idempotently record an event from an envelope into its respective domain storage.
   */
  async recordEvent(envelope: CompanionEventEnvelope): Promise<'inserted' | 'duplicate'> {
    if (envelope.domain === 'companion') {
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

      try {
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
          sourceIds: payload?.sourceIds ?? [envelope.sourceRef.id],
        });
        return 'inserted';
      } catch (err) {
        // If appendCompanionEvent did not throw conflict, it handled duplicate
        const existing = this.db.prepare('SELECT event_id FROM character_companion_timeline WHERE event_id=?').get(envelope.eventId);
        if (existing) return 'duplicate';
        throw err;
      }
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
      const executorId = payload?.executorId ?? 'harness';
      const taskId = payload?.taskId ?? envelope.sourceRef.id;
      const status = payload?.status ?? 'succeeded';
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
        const isRevoked = sourceIds.some(sId => this.characterPacks.isSourceRevoked(query.pairing.characterId, sId.split(':')[0]!));
        if (isRevoked || (!row.user_text && !row.assistant_text)) {
          continue; // Revoked or forgotten content is omitted from unified timeline reads
        }

        items.push({
          eventId: row.event_id,
          domain: 'companion',
          type: 'companion.turn.saved',
          occurredAt: row.created_at,
          summary: row.user_text.slice(0, 40),
          sourceRef: { id: row.turn_id, version: 1 },
          companionDetails: {
            userText: row.user_text,
            assistantText: row.assistant_text,
            sourceIds,
          },
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
