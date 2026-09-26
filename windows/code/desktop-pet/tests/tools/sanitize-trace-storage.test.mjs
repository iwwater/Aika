import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  analyzeDatabase,
  applySanitization,
  restoreDatabase,
  TRACE_DIGEST_PATTERN,
  sanitizeTraceText,
} from '../../tools/sanitize-trace-storage.mjs';

function createSyntheticTestDb(dbPath) {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE runtime_traces (
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
  `);

  const insert = db.prepare(`
    INSERT INTO runtime_traces (
      trace_id, turn_id, character_id, session_id, user_text, reply_text,
      total_elapsed_ms, status, stages_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // 4 legacy plain-text rows
  for (let i = 1; i <= 4; i++) {
    insert.run(
      `legacy-trace-${i}`,
      `legacy-turn-${i}`,
      'companion',
      `legacy-session-${i}`,
      `用户提问测试内容 ${i}`,
      `助手回答测试内容 ${i}`,
      100 + i * 10,
      i === 3 ? 'failed' : 'ok',
      JSON.stringify([
        { name: 'admission', label: '意图准入', elapsedMs: 5, status: 'ok', details: { route: 'chat' } },
        { name: 'context', label: '上下文检索', elapsedMs: 10, status: 'ok', details: { memories: 2 } },
        { name: 'llm', label: '模型生成', elapsedMs: 80, status: i === 3 ? 'failed' : 'ok', details: { model: 'test-model' } },
        ...(i !== 3 ? [{ name: 'distill', label: '记忆提炼', elapsedMs: 15, status: 'ok', details: i === 4 ? { items: [{ prompt: `nested prompt ${i}` }] } : { fact: `自动提炼事实 ${i}` } }] : [])
      ]),
      `2026-09-22T13:1${i}:00.000Z`
    );
  }

  // 4 modern sanitized rows
  for (let i = 5; i <= 8; i++) {
    insert.run(
      `modern-trace-${i}`,
      `modern-turn-${i}`,
      'companion',
      `modern-session-${i}`,
      sanitizeTraceText(`已脱敏提问 ${i}`),
      sanitizeTraceText(`已脱敏回答 ${i}`),
      120 + i * 10,
      i === 6 ? 'failed' : 'ok',
      JSON.stringify([
        { name: 'admission', label: '意图准入', elapsedMs: 5, status: 'ok', details: { route: 'chat' } },
        { name: 'context', label: '上下文检索', elapsedMs: 10, status: 'ok', details: { memories: 2 } },
        { name: 'llm', label: '模型生成', elapsedMs: 90, status: i === 6 ? 'failed' : 'ok', details: { model: 'test-model' } },
        { name: 'distill', label: '记忆提炼', elapsedMs: 15, status: 'ok', details: { fact: sanitizeTraceText(`自动提炼事实 ${i}`) } }
      ]),
      `2026-09-22T16:0${i}:00.000Z`
    );
  }

  db.close();
}

test('sanitize-trace-storage: dry-run, apply with backup, idempotency, and full rollback', async t => {
  const tempDir = mkdtempSync(join(tmpdir(), 'sanitize-trace-test-'));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));

  const dbPath = join(tempDir, 'test-companion.sqlite');
  createSyntheticTestDb(dbPath);

  // 1. Dry run analysis
  const dryRun = analyzeDatabase(dbPath);
  assert.equal(dryRun.totalRows, 8, 'total rows should be 8');
  assert.equal(dryRun.pendingUserText, 4, '4 rows should need user_text sanitizing');
  assert.equal(dryRun.pendingReplyText, 4, '4 rows should need reply_text sanitizing');
  assert.equal(dryRun.pendingStages, 3, '3 legacy distill rows should need stage details sanitizing');
  assert.equal(dryRun.affectedRows.length, 4, '4 rows total affected');

  // Verify dry run did not mutate DB
  const rawDbBefore = new Database(dbPath, { readonly: true });
  const rawCountBefore = rawDbBefore.prepare("SELECT count(*) as c FROM runtime_traces WHERE user_text NOT LIKE '[digest:%'").get();
  rawDbBefore.close();
  assert.equal(rawCountBefore.c, 4, 'dry run must not change database');

  // 2. Apply sanitization with automatic backup
  const backupFile = join(tempDir, 'pre-sanitize.backup.sqlite');
  const applyResult = applySanitization(dbPath, { backupPath: backupFile });
  assert.equal(applyResult.modified, 4, 'should modify exactly 4 legacy rows');
  assert.equal(applyResult.alreadyClean, false);
  assert.ok(existsSync(backupFile), 'backup file must exist');

  // Verify backup integrity
  const backupDb = new Database(backupFile, { readonly: true });
  assert.equal(backupDb.pragma('quick_check')[0].quick_check, 'ok');
  backupDb.close();

  // Verify post-apply state: 100% compliant
  const postAnalysis = analyzeDatabase(dbPath);
  assert.equal(postAnalysis.totalRows, 8);
  assert.equal(postAnalysis.pendingUserText, 0);
  assert.equal(postAnalysis.pendingReplyText, 0);
  assert.equal(postAnalysis.pendingStages, 0);
  assert.equal(postAnalysis.affectedRows.length, 0);

  const dbAfter = new Database(dbPath, { readonly: true });
  const allRows = dbAfter.prepare('SELECT user_text, reply_text, stages_json FROM runtime_traces').all();
  dbAfter.close();

  for (const row of allRows) {
    assert.match(row.user_text, TRACE_DIGEST_PATTERN);
    assert.match(row.reply_text, TRACE_DIGEST_PATTERN);
    const stages = JSON.parse(row.stages_json);
    for (const s of stages) {
      if (s.details?.fact) {
        assert.match(String(s.details.fact), TRACE_DIGEST_PATTERN);
      }
    }
  }

  // 3. Idempotency: re-running apply on clean DB makes 0 changes
  const secondApply = applySanitization(dbPath);
  assert.equal(secondApply.modified, 0);
  assert.equal(secondApply.alreadyClean, true);

  // 4. Rollback / Restore verification
  const restoreResult = restoreDatabase(dbPath, backupFile);
  assert.equal(restoreResult.success, true);

  const restoredAnalysis = analyzeDatabase(dbPath);
  assert.equal(restoredAnalysis.totalRows, 8);
  assert.equal(restoredAnalysis.pendingUserText, 4, 'restored DB should have 4 pending user_text rows');
  assert.equal(restoredAnalysis.pendingReplyText, 4, 'restored DB should have 4 pending reply_text rows');
  assert.equal(restoredAnalysis.pendingStages, 3, 'restored DB should have 3 pending stages rows');
});
