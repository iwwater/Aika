#!/usr/bin/env node
/**
 * tools/verify-real-trace-default-safety.mjs
 *
 * S1-C real-instance verification for ACCEPT-11.
 *
 * Opens the ACTUAL activated user database (read-only) through the PRODUCTION
 * `RuntimeTraceStore` and the PRODUCTION `startManagementServer`, then asserts that the
 * default `list` / `get` / `GET /api/traces` surfaces expose nothing but safe summaries.
 *
 * Privacy guarantee: this script NEVER prints user/reply bodies or stage detail values.
 * It reports counts, digest shapes, statuses and trace IDs only.
 *
 * Read-only: the SQLite handle is opened with `readonly` and no write path is reachable.
 */

import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { RuntimeTraceStore, TRACE_DIGEST_PATTERN } from '../dist/core/trace-store.js';
import { startManagementServer } from '../dist/management/server.js';
import { ManagementSettingsStore } from '../dist/management/settings-store.js';
import { ManagementRuntime } from '../dist/management/runtime.js';

const codeRoot = fileURLToPath(new URL('..', import.meta.url));
const projectRoot = fileURLToPath(new URL('../../..', import.meta.url));
const trialDir = resolve(projectRoot, '.local/model-evaluation/trial/user-trial');
const config = JSON.parse(await readFile(resolve(trialDir, 'config.json'), 'utf8'));
const dbPath = config.database;

const findings = [];
const record = (id, ok, detail) => findings.push({ id, status: ok ? 'PASS' : 'FAIL', detail });

// ---- 1. Raw storage baseline (aggregate counts only) -------------------------------------------
const raw = new Database(dbPath, { readonly: true });
const rawRows = raw.prepare('SELECT trace_id, user_text, reply_text, stages_json FROM runtime_traces ORDER BY created_at ASC').all();
raw.close();

let rawPlainUser = 0, rawPlainReply = 0, rawPlainStages = 0;
for (const row of rawRows) {
  if (row.user_text && !TRACE_DIGEST_PATTERN.test(row.user_text)) rawPlainUser++;
  if (row.reply_text && !TRACE_DIGEST_PATTERN.test(row.reply_text)) rawPlainReply++;
  try {
    for (const stage of JSON.parse(row.stages_json)) {
      for (const [, value] of Object.entries(stage.details ?? {})) {
        if (typeof value === 'string' && value.length > 0 && !TRACE_DIGEST_PATTERN.test(value)
          && !/^[a-zA-Z0-9_\-\.:]{1,64}$/.test(value)) { rawPlainStages++; break; }
      }
    }
  } catch {}
}

// ---- 2. Production store default read surface ---------------------------------------------------
const traces = RuntimeTraceStore.open(dbPath);
const list = traces.list({ characterId: config.characterId ?? 'companion', limit: 500, offset: 0, debugOptIn: false });

let listPlain = 0, listFields = 0;
for (const trace of list.traces) {
  for (const [field, value] of [['userText', trace.userText], ['replyText', trace.replyText]]) {
    listFields++;
    if (value && value.length > 0 && !TRACE_DIGEST_PATTERN.test(value)) listPlain++;
  }
  for (const stage of trace.stages) {
    for (const [key, value] of Object.entries(stage.details ?? {})) {
      if (typeof value !== 'string' || value.length === 0) continue;
      if (TRACE_DIGEST_PATTERN.test(value)) continue;
      if (/^[a-zA-Z0-9_\-\.:]{1,64}$/.test(value)) continue; // whitelisted safe metric
      listPlain++;
    }
  }
}
record('S1-A/store.list default masking', listPlain === 0,
  `traces=${list.traces.length} userReplyFields=${listFields} nonSummaryValues=${listPlain}`);

let getPlain = 0;
for (const trace of list.traces) {
  const single = traces.get(trace.traceId, false);
  if (!single) continue;
  for (const value of [single.userText, single.replyText]) {
    if (value && value.length > 0 && !TRACE_DIGEST_PATTERN.test(value)) getPlain++;
  }
}
record('S1-A/store.get default masking', getPlain === 0, `tracesChecked=${list.traces.length} nonSummaryValues=${getPlain}`);

// ---- 3. Production HTTP default surface ---------------------------------------------------------
const settings = await ManagementSettingsStore.open(join(trialDir, 'management-settings.json'), config);
const runtime = new ManagementRuntime(config.sourceRevision);
const server = await startManagementServer({
  uiRoot: resolve(codeRoot, 'management/ui'),
  settings,
  memory: {},
  traces,
  snapshot: () => ({
    apiVersion: 1, runtime: runtime.identity(), modules: [], events: [],
    settings: settings.snapshot(), adapters: [], credentials: [],
    characters: [{ id: config.characterId ?? 'companion', label: 'companion', revision: 0 }],
  }),
});

let apiStatus = 0, apiPlain = 0, apiTraces = 0, apiSummaryFields = 0;
try {
  const response = await fetch(`${server.origin}/api/traces`, {
    headers: { Authorization: `Bearer ${server.token}`, Origin: server.origin },
  });
  apiStatus = response.status;
  const payload = await response.json();
  apiTraces = Array.isArray(payload.traces) ? payload.traces.length : 0;
  for (const trace of payload.traces ?? []) {
    for (const [field, value] of [['userText', trace.userText], ['replyText', trace.replyText]]) {
      apiSummaryFields++;
      if (value && value.length > 0 && !TRACE_DIGEST_PATTERN.test(value)) apiPlain++;
    }
    for (const stage of trace.stages ?? []) {
      for (const [, value] of Object.entries(stage.details ?? {})) {
        if (typeof value !== 'string' || value.length === 0) continue;
        if (TRACE_DIGEST_PATTERN.test(value)) continue;
        if (/^[a-zA-Z0-9_\-\.:]{1,64}$/.test(value)) continue;
        apiPlain++;
      }
    }
  }
} finally {
  server.close();
}

record('S1-A/GET /api/traces default masking', apiStatus === 200 && apiPlain === 0,
  `status=${apiStatus} traces=${apiTraces} userReplyFields=${apiSummaryFields} nonSummaryValues=${apiPlain}`);

// ---- 4. Instance pin: does the activated config load the trace-security build? ------------------
const { createHash } = await import('node:crypto');
const hash = b => createHash('sha256').update(b).digest('hex');
const privacyArtifacts = [
  'code/desktop-pet/dist/core/trace-store.js',
  'code/desktop-pet/dist/management/server.js',
  'code/desktop-pet/dist/memory/trace-history-content.js',
  'code/desktop-pet/desktop/electron/main.mjs',
  'code/desktop-pet/desktop/main.mjs',
];
const pinStates = [];
for (const artifact of privacyArtifacts) {
  const pinned = config.runtimeFiles[artifact];
  if (pinned === undefined) { pinStates.push({ artifact, status: 'not-pinned' }); continue; }
  let actual = null;
  try { actual = hash(await readFile(resolve(projectRoot, artifact))); } catch {}
  pinStates.push({ artifact, status: actual === pinned ? 'in-sync' : 'drifted' });
}
const allPinned = pinStates.every(s => s.status === 'in-sync');
record('S1-C/trace-privacy artifacts in activated pin', allPinned,
  JSON.stringify(pinStates));

// ---- Report ------------------------------------------------------------------------------------
const failed = findings.filter(f => f.status === 'FAIL');
console.log(JSON.stringify({
  database: dbPath,
  rawStorage: {
    totalRows: rawRows.length,
    plainUserTextRows: rawPlainUser,
    plainReplyTextRows: rawPlainReply,
    rowsWithPlainStageDetails: rawPlainStages,
    isSanitizedAtRest: rawPlainUser === 0 && rawPlainReply === 0 && rawPlainStages === 0,
  },
  defaultSurface: { storeListNonSummary: listPlain, storeGetNonSummary: getPlain, apiNonSummary: apiPlain },
  findings,
  verdict: failed.length === 0 ? 'PASS_DEFAULT_SAFE' : 'FAIL',
  storageState: (rawPlainUser + rawPlainReply + rawPlainStages) === 0 ? 'SANITIZED_AT_REST' : 'STORAGE_PENDING',
}, null, 2));

process.exitCode = failed.length === 0 ? 0 : 1;
