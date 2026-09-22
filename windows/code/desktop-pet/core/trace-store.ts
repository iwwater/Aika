// N075-12 / Trace Store: Persistent SQLite storage for end-to-end conversation call traces.
import Database from 'better-sqlite3';

export interface TraceStage {
  name: 'admission' | 'context' | 'llm' | 'distill' | 'tts';
  label: string;
  elapsedMs: number;
  status: 'ok' | 'skipped' | 'failed';
  details?: Record<string, unknown>;
}

export interface RuntimeTrace {
  traceId: string;
  turnId: string;
  characterId: string;
  sessionId: string;
  userText: string;
  replyText: string;
  totalElapsedMs: number;
  status: 'ok' | 'failed';
  tokens?: {
    inputTokens?: number | undefined;
    outputTokens?: number | undefined;
    totalTokens?: number | undefined;
  } | undefined;
  stages: TraceStage[];
  createdAt: string;
}

export interface TraceQueryOptions {
  characterId?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export interface TraceListResult {
  total: number;
  offset: number;
  limit: number;
  traces: RuntimeTrace[];
  summary: {
    totalCount: number;
    avgElapsedMs: number;
    successRate: number;
    totalTokens: number;
  };
}

export class RuntimeTraceStore {
  private constructor(private readonly db: Database.Database) {}

  static open(dbOrPath: Database.Database | string): RuntimeTraceStore {
    const db = typeof dbOrPath === 'string' ? new Database(dbOrPath) : dbOrPath;
    db.exec(`
      CREATE TABLE IF NOT EXISTS runtime_traces (
        trace_id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL,
        character_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        user_text TEXT NOT NULL,
        reply_text TEXT NOT NULL,
        total_elapsed_ms INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('ok', 'failed')),
        input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        total_tokens INTEGER DEFAULT 0,
        stages_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_runtime_traces_created ON runtime_traces(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_runtime_traces_char ON runtime_traces(character_id, created_at DESC);
    `);
    return new RuntimeTraceStore(db);
  }

  record(trace: RuntimeTrace): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO runtime_traces (
        trace_id, turn_id, character_id, session_id, user_text, reply_text,
        total_elapsed_ms, status, input_tokens, output_tokens, total_tokens,
        stages_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      trace.traceId,
      trace.turnId,
      trace.characterId,
      trace.sessionId,
      trace.userText,
      trace.replyText,
      trace.totalElapsedMs,
      trace.status,
      trace.tokens?.inputTokens || 0,
      trace.tokens?.outputTokens || 0,
      trace.tokens?.totalTokens || 0,
      JSON.stringify(trace.stages || []),
      trace.createdAt || new Date().toISOString()
    );
  }

  list(options: TraceQueryOptions = {}): TraceListResult {
    const limit = Math.max(1, Math.min(100, options.limit ?? 20));
    const offset = Math.max(0, options.offset ?? 0);
    const characterId = options.characterId;

    let whereClause = '';
    const params: unknown[] = [];
    if (characterId) {
      whereClause = 'WHERE character_id = ?';
      params.push(characterId);
    }

    const totalRow = this.db
      .prepare(`SELECT count(*) as total, avg(total_elapsed_ms) as avg_ms, sum(total_tokens) as tokens FROM runtime_traces ${whereClause}`)
      .get(...params) as { total: number; avg_ms: number | null; tokens: number | null };

    const total = totalRow?.total || 0;
    const avgMs = Math.round(totalRow?.avg_ms || 0);
    const totalTokens = totalRow?.tokens || 0;

    const okRow = this.db
      .prepare(`SELECT count(*) as ok_count FROM runtime_traces ${whereClause ? whereClause + " AND status = 'ok'" : "WHERE status = 'ok'"}`)
      .get(...params) as { ok_count: number };

    const okCount = okRow?.ok_count || 0;
    const successRate = total > 0 ? Math.round((okCount / total) * 100) : 100;

    const rows = this.db
      .prepare(`SELECT * FROM runtime_traces ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as Array<{
        trace_id: string;
        turn_id: string;
        character_id: string;
        session_id: string;
        user_text: string;
        reply_text: string;
        total_elapsed_ms: number;
        status: 'ok' | 'failed';
        input_tokens: number;
        output_tokens: number;
        total_tokens: number;
        stages_json: string;
        created_at: string;
      }>;

    const traces: RuntimeTrace[] = rows.map(r => {
      let stages: TraceStage[] = [];
      try {
        stages = JSON.parse(r.stages_json);
      } catch {}

      return {
        traceId: r.trace_id,
        turnId: r.turn_id,
        characterId: r.character_id,
        sessionId: r.session_id,
        userText: r.user_text,
        replyText: r.reply_text,
        totalElapsedMs: r.total_elapsed_ms,
        status: r.status,
        tokens: {
          inputTokens: r.input_tokens,
          outputTokens: r.output_tokens,
          totalTokens: r.total_tokens,
        },
        stages,
        createdAt: r.created_at,
      };
    });

    return {
      total,
      offset,
      limit,
      traces,
      summary: {
        totalCount: total,
        avgElapsedMs: avgMs,
        successRate,
        totalTokens,
      },
    };
  }

  get(traceId: string): RuntimeTrace | null {
    const row = this.db.prepare('SELECT * FROM runtime_traces WHERE trace_id = ?').get(traceId) as {
      trace_id: string;
      turn_id: string;
      character_id: string;
      session_id: string;
      user_text: string;
      reply_text: string;
      total_elapsed_ms: number;
      status: 'ok' | 'failed';
      input_tokens: number;
      output_tokens: number;
      total_tokens: number;
      stages_json: string;
      created_at: string;
    } | undefined;

    if (!row) return null;

    let stages: TraceStage[] = [];
    try {
      stages = JSON.parse(row.stages_json);
    } catch {}

    return {
      traceId: row.trace_id,
      turnId: row.turn_id,
      characterId: row.character_id,
      sessionId: row.session_id,
      userText: row.user_text,
      replyText: row.reply_text,
      totalElapsedMs: row.total_elapsed_ms,
      status: row.status,
      tokens: {
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        totalTokens: row.total_tokens,
      },
      stages,
      createdAt: row.created_at,
    };
  }
}
