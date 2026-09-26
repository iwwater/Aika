// Aika Next minimal Chat Timeline: a small independent SQLite table plus a turn-event recorder.
// Events are unique by eventId (idempotent replay, conflict on divergence), pagination uses a
// stable persisted sort key, redaction keeps tombstones, and recording retries at most three
// times without ever blocking or rolling back the conversation itself.
import Database from 'better-sqlite3';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { ManagementError } from '../contracts/management.js';
import type { TurnScope } from '../contracts/index.js';
import type { TurnEnd, TurnPortEvent } from '../core/turn-port.js';

export interface ChatEvent {
  readonly schemaVersion: 1;
  readonly eventId: string;
  readonly scope: TurnScope;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly kind: 'userMessage' | 'assistantTerminal';
  readonly messageId: string;
  readonly text?: string;
  readonly status?: TurnEnd;
}

export class TimelineConflictError extends Error {
  constructor(readonly eventId: string) {
    super(`Timeline 事件冲突：eventId ${eventId} 已存在但内容不同`);
    this.name = 'TimelineConflictError';
  }
}

interface Row {
  event_id: string; schema_version: number; character_id: string; session_id: string; turn_id: string;
  generation: number; sequence: number; occurred_at: string; sort_key: number; kind: string;
  message_id: string; text: string | null; status: string | null; redacted: number;
}

function timestamp(value: string): void {
  if (Number.isNaN(Date.parse(value))) throw new ManagementError('invalid_request', 'occurredAt 必须是合法时间戳');
}

function toRow(event: ChatEvent, sortKey: number): Row {
  return {
    event_id: event.eventId, schema_version: event.schemaVersion, character_id: event.scope.characterId,
    session_id: event.scope.sessionId, turn_id: event.scope.turnId, generation: event.scope.generation,
    sequence: event.sequence, occurred_at: event.occurredAt, sort_key: sortKey,
    kind: event.kind, message_id: event.messageId, text: event.text ?? null, status: event.status ?? null, redacted: 0
  };
}

function toEvent(row: Row): ChatEvent {
  return {
    schemaVersion: 1, eventId: row.event_id,
    scope: { characterId: row.character_id, sessionId: row.session_id, turnId: row.turn_id, generation: row.generation },
    sequence: row.sequence, occurredAt: row.occurred_at,
    kind: row.kind as ChatEvent['kind'], messageId: row.message_id,
    ...(row.redacted || row.text === null ? {} : { text: row.text }),
    ...(row.status === null ? {} : { status: row.status as TurnEnd })
  };
}

function samePayload(row: Row, event: ChatEvent): boolean {
  return row.schema_version === event.schemaVersion && row.character_id === event.scope.characterId
    && row.session_id === event.scope.sessionId && row.turn_id === event.scope.turnId
    && row.generation === event.scope.generation && row.sequence === event.sequence
    && row.occurred_at === event.occurredAt && row.kind === event.kind
    && row.message_id === event.messageId && row.text === (event.text ?? null)
    && row.status === (event.status ?? null);
}

export class AikaTimelineStore {
  readonly #db: Database.Database;
  #closed = false;

  private constructor(filename: string) {
    this.#db = new Database(filename);
    // Default rollback journal: no persistent -wal/-shm side files, which Windows test cleanup cannot remove.
    this.#db.pragma('synchronous = FULL');
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS chat_events (
        event_id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        character_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        sequence INTEGER NOT NULL,
        occurred_at TEXT NOT NULL,
        sort_key INTEGER NOT NULL UNIQUE,
        kind TEXT NOT NULL CHECK(kind IN ('userMessage','assistantTerminal')),
        message_id TEXT NOT NULL,
        text TEXT,
        status TEXT,
        redacted INTEGER NOT NULL DEFAULT 0 CHECK(redacted IN (0,1))
      );
      CREATE INDEX IF NOT EXISTS chat_events_session ON chat_events(session_id, sort_key);
    `);
  }

  static async open(filename: string): Promise<AikaTimelineStore> {
    const path = resolve(filename);
    await mkdir(dirname(path), { recursive: true });
    return new AikaTimelineStore(path);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }

  async append(event: ChatEvent): Promise<'inserted' | 'duplicate'> {
    if (!event.eventId?.trim() || !event.messageId?.trim()) throw new ManagementError('invalid_request', 'eventId/messageId 不能为空');
    if (event.kind !== 'userMessage' && event.kind !== 'assistantTerminal') throw new ManagementError('invalid_request', 'kind 非法');
    if (!Number.isSafeInteger(event.sequence) || event.sequence < 0) throw new ManagementError('invalid_request', 'sequence 非法');
    timestamp(event.occurredAt);
    const transaction = this.#db.transaction((): 'inserted' | 'duplicate' => {
      const existing = this.#db.prepare('SELECT * FROM chat_events WHERE event_id=?').get(event.eventId) as Row | undefined;
      if (existing) {
        // A redacted row never revives its text, whatever the replay carries.
        if (existing.redacted) return 'duplicate';
        if (samePayload(existing, event)) return 'duplicate';
        throw new TimelineConflictError(event.eventId);
      }
      const sortKey = (this.#db.prepare('SELECT COALESCE(MAX(sort_key),0) AS k FROM chat_events').get() as { k: number }).k + 1;
      this.#db.prepare(`INSERT INTO chat_events (event_id,schema_version,character_id,session_id,turn_id,generation,sequence,occurred_at,sort_key,kind,message_id,text,status,redacted)
        VALUES (@event_id,@schema_version,@character_id,@session_id,@turn_id,@generation,@sequence,@occurred_at,@sort_key,@kind,@message_id,@text,@status,0)`).run(toRow(event, sortKey));
      return 'inserted';
    });
    return transaction();
  }

  async list(query: { sessionId: string; cursor?: string; limit: number }): Promise<{ items: ChatEvent[]; nextCursor?: string }> {
    if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 100) throw new ManagementError('invalid_request', 'limit 取 1～100');
    let cursorKey = 0;
    if (query.cursor !== undefined) {
      cursorKey = Number(query.cursor);
      if (!Number.isSafeInteger(cursorKey) || cursorKey < 0) throw new ManagementError('invalid_request', 'cursor 非法');
    }
    const rows = this.#db.prepare('SELECT * FROM chat_events WHERE session_id=? AND sort_key>? ORDER BY sort_key LIMIT ?')
      .all(query.sessionId, cursorKey, query.limit + 1) as Row[];
    const items = rows.slice(0, query.limit).map(toEvent);
    if (rows.length > query.limit) return { items, nextCursor: String(rows[query.limit - 1]!.sort_key) };
    return { items };
  }

  async redactByMessageIds(ids: readonly string[]): Promise<void> {
    const unique = [...new Set(ids)];
    if (!unique.length) return;
    const statement = this.#db.prepare('UPDATE chat_events SET text=NULL, redacted=1 WHERE message_id=?');
    const transaction = this.#db.transaction(() => { for (const id of unique) statement.run(id); });
    transaction();
  }
}

export interface TimelineEventSource {
  subscribe(listener: (event: TurnPortEvent) => void): () => void;
}
export interface TimelineStorage {
  append(event: ChatEvent): Promise<'inserted' | 'duplicate'>;
}

export interface TimelineRecorderOptions {
  /** Total attempts per event, default 3. Retries are immediate; no unbounded loops. */
  readonly retries?: number;
  readonly onError?: (error: unknown) => void;
}

/** Subscribes to turn events and records accepted inputs and assistant terminals, retrying bounded. */
export class AikaTimelineRecorder {
  #unsubscribe: (() => void) | undefined;
  #stopped = false;
  #pending: Promise<void> = Promise.resolve();
  readonly #attempts: number;

  constructor(private readonly source: TimelineEventSource, private readonly storage: TimelineStorage, private readonly options: TimelineRecorderOptions = {}) {
    this.#attempts = Math.max(1, options.retries ?? 3);
  }

  start(): () => void {
    if (this.#stopped) throw new ManagementError('unavailable', 'Timeline 记录器已停止，不能重启。');
    if (this.#unsubscribe) throw new ManagementError('invalid_request', 'Timeline 记录器已启动。');
    const lastReply = new Map<string, string>();
    const enqueue = (task: () => Promise<void>) => {
      this.#pending = this.#pending.then(task, task);
    };
    this.#unsubscribe = this.source.subscribe(event => {
      if (event.type === 'accepted') {
        enqueue(() => this.#append({
          schemaVersion: 1, eventId: `evt-${event.scope.turnId}-user`, scope: event.scope, sequence: event.sequence,
          occurredAt: new Date().toISOString(), kind: 'userMessage', messageId: `${event.scope.turnId}:user`, text: event.text
        }));
      } else if (event.type === 'reply') {
        lastReply.set(event.scope.turnId, event.text);
      } else if (event.type === 'terminal') {
        const partial = lastReply.get(event.scope.turnId);
        const text = event.status === 'completed' ? (event.replyText ?? partial) : partial;
        enqueue(() => this.#append({
          schemaVersion: 1, eventId: `evt-${event.scope.turnId}-assistant`, scope: event.scope, sequence: event.sequence,
          occurredAt: new Date().toISOString(), kind: 'assistantTerminal', messageId: `${event.scope.turnId}:assistant`,
          ...(text === undefined ? {} : { text }), status: event.status
        }));
      }
    });
    return () => this.stop();
  }

  stop(): void {
    this.#stopped = true;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
  }

  async drain(): Promise<void> { await this.#pending; }

  async #append(event: ChatEvent): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.storage.append(event);
        return;
      } catch (error) {
        if (error instanceof TimelineConflictError || attempt >= this.#attempts) {
          this.options.onError?.(error);
          return;
        }
      }
    }
  }
}
