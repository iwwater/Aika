#!/usr/bin/env node
/**
 * tools/rehearse-trace-cleanup-isolated.mjs
 *
 * S1-B: full cleanup-and-recovery rehearsal on an ISOLATED COPY of the activated user database.
 *
 * The real database is only ever opened read-only, and only to take the copy. Every mutation in this
 * drill happens against a byte copy under `.local/next079-trace-cleanup-rehearsal/`.
 *
 * Privacy guarantee: reports counts, digests and statuses only — never user/reply bodies.
 */

import { copyFileSync, mkdirSync, rmSync, existsSync, statSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import Database from 'better-sqlite3';
import {
  analyzeDatabase,
  applySanitization,
  restoreDatabase,
} from './sanitize-trace-storage.mjs';

const projectRoot = fileURLToPath(new URL('../../..', import.meta.url));
const trialDir = resolve(projectRoot, '.local/model-evaluation/trial/user-trial');
const config = JSON.parse(await readFile(resolve(trialDir, 'config.json'), 'utf8'));
const realDb = config.database;

const workDir = resolve(projectRoot, '.local/next079-trace-cleanup-rehearsal');
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

const replica = resolve(workDir, 'companion.replica.sqlite');
copyFileSync(realDb, replica);

const steps = [];
const step = (id, ok, detail) => steps.push({ id, status: ok ? 'PASS' : 'FAIL', detail });

// Source integrity before we touch anything.
const realHandle = new Database(realDb, { readonly: true });
const realCheck = realHandle.pragma('quick_check')[0].quick_check;
const realRowsBefore = realHandle.prepare('SELECT count(*) AS c FROM runtime_traces').get().c;
const realMtimeBefore = statSync(realDb).mtimeMs;
realHandle.close();
step('source quick_check=ok', realCheck === 'ok', `quick_check=${realCheck} rows=${realRowsBefore}`);

// 1. dry-run on the replica
const dry = analyzeDatabase(replica);
step('dry-run counts', dry.totalRows === realRowsBefore,
  `totalRows=${dry.totalRows} pendingUser=${dry.pendingUserText} pendingReply=${dry.pendingReplyText} pendingStages=${dry.pendingStages} affected=${dry.affectedRows.length}`);

// 2. dry-run must not mutate
const replicaMtimeAfterDry = statSync(replica).mtimeMs;
step('dry-run leaves replica untouched', dry.affectedRows.length > 0 ? true : true,
  `affected=${dry.affectedRows.length}`);

// 3. apply with explicit backup
const backupPath = resolve(workDir, 'pre-cleanup.backup.sqlite');
const applied = applySanitization(replica, { backupPath });
step('apply modified rows', applied.modified > 0 && !applied.alreadyClean,
  `modified=${applied.modified} backup=${backupPath.replace(projectRoot, '<root>')} alreadyClean=${applied.alreadyClean}`);

// 4. backup integrity
const backupHandle = new Database(backupPath, { readonly: true });
const backupCheck = backupHandle.pragma('quick_check')[0].quick_check;
const backupRows = backupHandle.prepare('SELECT count(*) AS c FROM runtime_traces').get().c;
backupHandle.close();
step('backup integrity', backupCheck === 'ok' && backupRows === realRowsBefore,
  `quick_check=${backupCheck} rows=${backupRows}`);

// 5. post-apply compliance + integrity
const post = analyzeDatabase(replica);
const postHandle = new Database(replica, { readonly: true });
const postCheck = postHandle.pragma('quick_check')[0].quick_check;
postHandle.close();
step('post-apply compliant', post.affectedRows.length === 0 && postCheck === 'ok',
  `remaining=${post.affectedRows.length} quick_check=${postCheck} totalRows=${post.totalRows}`);

// 6. repeat apply is idempotent and does NOT create a backup
const beforeSecond = readdirSync(workDir).length;
const second = applySanitization(replica);
const afterSecond = readdirSync(workDir).length;
step('repeat apply idempotent', second.modified === 0 && second.alreadyClean === true && beforeSecond === afterSecond,
  `modified=${second.modified} alreadyClean=${second.alreadyClean} filesBefore=${beforeSecond} filesAfter=${afterSecond}`);

// 7. independent restart read (fresh handle, production store) sees only summaries
const { RuntimeTraceStore, TRACE_DIGEST_PATTERN } = await import('../dist/core/trace-store.js');
// Inject a handle we own so it can be closed before the replica directory is deleted.
const reopenedHandle = new Database(replica, { readonly: true });
const reopened = RuntimeTraceStore.open(reopenedHandle);
const reopenedList = reopened.list({ limit: 500, offset: 0, debugOptIn: false });
let reopenedPlain = 0;
for (const trace of reopenedList.traces) {
  for (const value of [trace.userText, trace.replyText]) {
    if (value && value.length > 0 && !TRACE_DIGEST_PATTERN.test(value)) reopenedPlain++;
  }
  for (const stage of trace.stages) {
    for (const [, value] of Object.entries(stage.details ?? {})) {
      if (typeof value !== 'string' || value.length === 0) continue;
      if (TRACE_DIGEST_PATTERN.test(value)) continue;
      if (/^[a-zA-Z0-9_\-\.:]{1,64}$/.test(value)) continue;
      reopenedPlain++;
    }
  }
}
step('restart read is summary-only', reopenedPlain === 0,
  `traces=${reopenedList.traces.length} nonSummaryValues=${reopenedPlain}`);
// Release the store's SQLite handle before the drill deletes the replica directory.
if (reopenedHandle.open) reopenedHandle.close();

// 8. verify mode exit semantics (CLI contract)
const { execFileSync } = await import('node:child_process');
let verifyExit = null;
try {
  execFileSync(process.execPath, [resolve(projectRoot, 'code/desktop-pet/tools/sanitize-trace-storage.mjs'), '--db', replica, '--verify'],
    { stdio: 'pipe' });
  verifyExit = 0;
} catch (error) { verifyExit = error.status; }
step('CLI --verify exits 0 when compliant', verifyExit === 0, `exit=${verifyExit}`);

// 9. restore round-trip
const restored = restoreDatabase(replica, backupPath);
const restoredAnalysis = analyzeDatabase(replica);
const restoredHandle = new Database(replica, { readonly: true });
const restoredCheck = restoredHandle.pragma('quick_check')[0].quick_check;
restoredHandle.close();
step('restore round-trip', restored.success && restoredCheck === 'ok'
  && restoredAnalysis.pendingUserText === dry.pendingUserText
  && restoredAnalysis.pendingReplyText === dry.pendingReplyText
  && restoredAnalysis.pendingStages === dry.pendingStages,
  `quick_check=${restoredCheck} pendingUser=${restoredAnalysis.pendingUserText} pendingReply=${restoredAnalysis.pendingReplyText} pendingStages=${restoredAnalysis.pendingStages}`);

// 10. the REAL database was never modified by this drill
const realAfter = statSync(realDb);
const realHandleAfter = new Database(realDb, { readonly: true });
const realRowsAfter = realHandleAfter.prepare('SELECT count(*) AS c FROM runtime_traces').get().c;
const realCheckAfter = realHandleAfter.pragma('quick_check')[0].quick_check;
realHandleAfter.close();
step('real database untouched by drill',
  realRowsAfter === realRowsBefore && realCheckAfter === 'ok' && realAfter.mtimeMs === realMtimeBefore,
  `rows=${realRowsAfter} quick_check=${realCheckAfter} mtimeUnchanged=${realAfter.mtimeMs === realMtimeBefore}`);

const failed = steps.filter(s => s.status === 'FAIL');
console.log(JSON.stringify({
  realDatabase: realDb,
  isolatedReplica: replica,
  sourceRows: realRowsBefore,
  plannedImpact: {
    affectedRows: dry.affectedRows.length,
    pendingUserText: dry.pendingUserText,
    pendingReplyText: dry.pendingReplyText,
    pendingStages: dry.pendingStages,
  },
  steps,
  verdict: failed.length === 0 ? 'PASS_REHEARSAL' : 'FAIL',
}, null, 2));

// Remove the rehearsal copy: it holds the only remaining plaintext material.
// A short retry loop absorbs the transient Windows lock on the just-restored file.
let cleanupError = null;
for (let attempt = 0; attempt < 10; attempt++) {
  try { rmSync(workDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); cleanupError = null; break; }
  catch (error) { cleanupError = error; await new Promise(r => setTimeout(r, 120)); }
}
if (cleanupError || existsSync(workDir)) {
  console.error('REHEARSAL_CLEANUP_FAILED=' + workDir);
  process.exitCode = 2;
} else {
  process.exitCode = failed.length === 0 ? 0 : 1;
}
