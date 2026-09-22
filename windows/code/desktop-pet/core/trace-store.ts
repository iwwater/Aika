// N075-12 / Trace Store: Persistent SQLite storage for end-to-end conversation call traces.
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';

export type TraceStageName =
  | 'admission'
  | 'context'
  | 'llm'
  | 'assistant_persist'
  | 'memory_enqueue'
  | 'memory_plan'
  | 'memory_commit'
  | 'summary'
  | 'tts'
  | 'distill';

export interface TraceStage {
  name: TraceStageName;
  label: string;
  elapsedMs: number;
  status: 'ok' | 'skipped' | 'failed' | 'cancelled';
  category?: 'foreground' | 'background' | undefined;
  startedAt?: string | undefined;
  endedAt?: string | undefined;
  details?: Record<string, unknown> | undefined;
}

export function sanitizeTraceText(text: string): string {
  if (!text) return '';
  const len = [...text].length;
  const digest = createHash('sha256').update(text).digest('hex').slice(0, 8);
  return `[digest:${digest} len:${len}]`;
}

const SAFE_METRIC_KEYS = new Set([
  'memories', 'recent', 'inputTokenBudget', 'elapsedMs', 'count', 'tokens',
  'totalTokens', 'inputTokens', 'outputTokens', 'affectedCount', 'sequence',
  'completed', 'total', 'hasContinuity', 'retrievalInvalidated', 'ok',
  'emotion', 'route', 'request', 'status', 'name', 'label', 'code', 'error',
  'model', 'provider', 'outcomeStatus', 'requestId', 'stage',
]);

/**
 * RV75-03: Stage details whitelist sanitization.
 * Prevents plain-text personal memories, conversation transcripts and user facts
 * from leaking into the trace stage details payload unless debugOptIn is explicitly true.
 */
export function sanitizeStageDetails(
  details: Record<string, unknown> | undefined,
  debugOptIn = false,
): Record<string, unknown> | undefined {
  if (!details || debugOptIn) return details;
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'number' || typeof value === 'boolean') {
      sanitized[key] = value;
      continue;
    }
    if (typeof value === 'string') {
      // Safe metadata keywords and short code identifiers
      if (SAFE_METRIC_KEYS.has(key) && /^[a-zA-Z0-9_\-\.:]{1,64}$/.test(value)) {
        sanitized[key] = value;
      } else {
        sanitized[key] = sanitizeTraceText(value);
      }
      continue;
    }
    if (Array.isArray(value)) {
      if (key === 'affectedIds') {
        sanitized[key] = value.filter(v => typeof v === 'string' && /^[a-zA-Z0-9_\-\.:]{1,64}$/.test(v));
      } else {
        // Redact any free-form text elements (such as retrievedMemories or prompts)
        sanitized[key] = value.map(v => typeof v === 'string' ? sanitizeTraceText(v) : v);
      }
      continue;
    }
    if (typeof value === 'object') {
      sanitized[key] = sanitizeStageDetails(value as Record<string, unknown>, debugOptIn);
    }
  }
  return sanitized;
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
      CREATE INDEX IF NOT EXISTS idx_runtime_traces_turn ON runtime_traces(turn_id);

      -- RV75-05: Buffer for early background stages arriving before foreground trace record is created
      CREATE TABLE IF NOT EXISTS runtime_trace_pending_stages (
        turn_id TEXT NOT NULL,
        stage_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pending_stages_turn ON runtime_trace_pending_stages(turn_id);
    `);
    return new RuntimeTraceStore(db);
  }

  /**
   * Records a complete turn trace.
   * Privacy: by default (debugOptIn: false), user_text, reply_text, and stage details are sanitized
   * to cryptographic digests or whitelisted metadata so the trace store does not become a second
   * persistent chat transcript or memory database. Full bodies are persisted only when debugOptIn: true.
   */
  record(trace: RuntimeTrace, debugOptIn = false): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO runtime_traces (
        trace_id, turn_id, character_id, session_id, user_text, reply_text,
        total_elapsed_ms, status, input_tokens, output_tokens, total_tokens,
        stages_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const storedUserText = debugOptIn ? trace.userText : sanitizeTraceText(trace.userText);
    const storedReplyText = debugOptIn ? trace.replyText : sanitizeTraceText(trace.replyText);

    let stages: TraceStage[] = (trace.stages || []).map(s => ({
      ...s,
      details: sanitizeStageDetails(s.details, debugOptIn),
    }));

    // RV75-05: Merge early pending background stages if any completed before record()
    try {
      const pendingRows = this.db
        .prepare('SELECT rowid, stage_json FROM runtime_trace_pending_stages WHERE turn_id=?')
        .all(trace.turnId) as Array<{ rowid: number; stage_json: string }>;
      if (pendingRows.length > 0) {
        for (const p of pendingRows) {
          try {
            const pendingStage = JSON.parse(p.stage_json) as TraceStage;
            if (!stages.some(s => s.name === pendingStage.name && s.label === pendingStage.label)) {
              stages.push(pendingStage);
            }
          } catch {}
        }
        this.db.prepare('DELETE FROM runtime_trace_pending_stages WHERE turn_id=?').run(trace.turnId);
      }
    } catch {}

    // Check if an existing row with this trace_id already has stages
    try {
      const existingRow = this.db
        .prepare('SELECT stages_json, total_elapsed_ms FROM runtime_traces WHERE trace_id=?')
        .get(trace.traceId) as { stages_json: string; total_elapsed_ms: number } | undefined;
      if (existingRow) {
        const existingStages = JSON.parse(existingRow.stages_json) as TraceStage[];
        for (const es of existingStages) {
          if (!stages.some(s => s.name === es.name && s.label === es.label)) {
            stages.push(es);
          }
        }
      }
    } catch {}

    const totalElapsed = Math.max(trace.totalElapsedMs, ...stages.map(s => s.elapsedMs));

    stmt.run(
      trace.traceId,
      trace.turnId,
      trace.characterId,
      trace.sessionId,
      storedUserText,
      storedReplyText,
      totalElapsed,
      trace.status,
      trace.tokens?.inputTokens || 0,
      trace.tokens?.outputTokens || 0,
      trace.tokens?.totalTokens || 0,
      JSON.stringify(stages),
      trace.createdAt || new Date().toISOString()
    );
  }

  /**
   * Appends an asynchronous background stage (e.g. memory_plan, memory_commit, summary)
   * to an existing foreground turn trace by turnId, updating elapsed time and stages list.
   * If the foreground record has not yet been written (race condition RV75-05), the stage is
   * saved into runtime_trace_pending_stages and merged when record() is called.
   * Returns true in both cases.
   */
  appendStage(turnId: string, stage: TraceStage, debugOptIn = false): boolean {
    const safeStage: TraceStage = {
      ...stage,
      details: sanitizeStageDetails(stage.details, debugOptIn),
    };

    const row = this.db
      .prepare('SELECT trace_id, stages_json, total_elapsed_ms FROM runtime_traces WHERE turn_id=? ORDER BY created_at DESC LIMIT 1')
      .get(turnId) as { trace_id: string; stages_json: string; total_elapsed_ms: number } | undefined;
    if (!row) {
      // RV75-05: Store in pending table so record() can claim it
      this.db
        .prepare('INSERT INTO runtime_trace_pending_stages (turn_id, stage_json, created_at) VALUES (?, ?, ?)')
        .run(turnId, JSON.stringify(safeStage), new Date().toISOString());
      return true;
    }

    let stages: TraceStage[] = [];
    try { stages = JSON.parse(row.stages_json); } catch {}
    const existingIndex = stages.findIndex(s => s.name === safeStage.name && s.label === safeStage.label);
    if (existingIndex >= 0) {
      stages[existingIndex] = safeStage;
    } else {
      stages.push(safeStage);
    }

    const updatedElapsed = Math.max(row.total_elapsed_ms, safeStage.elapsedMs);
    this.db
      .prepare('UPDATE runtime_traces SET stages_json=?, total_elapsed_ms=? WHERE trace_id=?')
      .run(JSON.stringify(stages), updatedElapsed, row.trace_id);
    return true;
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
