import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { fixture } from '../management/helpers.js';
import { fixture as historyFixture } from '../memory/sqlite-fixture.js';
import { ManagementSettingsStore } from '../../management/settings-store.js';
import { ManagementRuntime } from '../../management/runtime.js';
import { startManagementServer } from '../../management/server.js';
import { RuntimeTraceStore, type RuntimeTrace } from '../../core/trace-store.js';
import { readTraceContentFromHistory } from '../../memory/trace-history-content.js';

const root = resolve(import.meta.dirname, '../../../../..');

test('N079-02 trace bodies stay masked at rest and are available only through the authenticated History-backed route', async t => {
  const f = await fixture(t);
  const historyFixtureStore = historyFixture(300_000_000, 'next079-trace');
  const history = historyFixtureStore.open();
  t.after(() => historyFixtureStore.cleanup());
  const traces = RuntimeTraceStore.open(history.rawDatabaseForKnowledge());
  const scope = { characterId: 'companion' as const, sessionId: 'session-079', turnId: 'turn-079', generation: 1 };
  history.append(scope, [
    { id: 'turn-079:user', characterId: 'companion', role: 'user', text: '我的私密测试内容', createdAt: '2026-09-23T08:00:00.000Z' },
    { id: 'turn-079:assistant', characterId: 'companion', role: 'assistant', text: '这是合成回复', createdAt: '2026-09-23T08:00:00.000Z' },
  ]);
  const trace: RuntimeTrace = {
    traceId: 'trace-079', turnId: 'turn-079', characterId: 'companion', sessionId: 'session-079',
    userText: '我的私密测试内容', replyText: '这是合成回复', totalElapsedMs: 4, status: 'ok', stages: [], createdAt: '2026-09-23T08:00:00.000Z',
  };
  traces.record(trace);
  const content = () => readTraceContentFromHistory(history, trace);
  const settings = await ManagementSettingsStore.open(join(f.c.projectRoot, 'settings.json'), f.c);
  const runtime = new ManagementRuntime(f.c.sourceRevision);
  const server = await startManagementServer({
    uiRoot: resolve(root, 'code/desktop-pet/management/ui'), settings,
    memory: {} as never,
    traces,
    traceContent: content,
    snapshot: () => ({ apiVersion: 1, runtime: runtime.identity(), modules: [], events: [], settings: settings.snapshot(), adapters: [], credentials: [], characters: [{ id: 'companion', label: '陪伴者', revision: 0 }] }),
  });
  t.after(() => server.close());
  const headers = { Authorization: `Bearer ${server.token}`, Origin: server.origin };
  assert.equal((await fetch(`${server.origin}/api/traces/trace-079/content`)).status, 401);
  assert.equal((await fetch(`${server.origin}/api/traces/trace-079/content`, { headers: { ...headers, Origin: 'https://foreign.invalid' } })).status, 403);

  const list = await fetch(`${server.origin}/api/traces`, { headers });
  assert.equal(list.status, 200);
  const listed = await list.json() as { traces: Array<{ userText: string; replyText: string }> };
  assert.match(listed.traces[0]!.userText, /^\[digest:/);
  assert.doesNotMatch(JSON.stringify(listed), /我的私密测试内容|这是合成回复/);

  const body = await fetch(`${server.origin}/api/traces/trace-079/content`, { headers });
  assert.deepEqual(await body.json(), content());

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const harness = resolve(import.meta.dirname, '../../../tests/management/trace-content-electron.mjs');
  const child = spawn(createRequire(import.meta.url)('electron'), [harness, server.origin + '/#token=' + server.token + '&page=events'],
    { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let output = '';
  child.stdout.on('data', bytes => { output += bytes; });
  child.stderr.on('data', bytes => t.diagnostic(bytes.toString()));
  await new Promise<void>((resolveExit, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(Error('Electron Trace UI scenario timed out')); }, 30_000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); code === 0 ? resolveExit() : reject(Error('Electron exited ' + code)); });
  });
  const resultLine = output.split(/\r?\n/).find(value => value.startsWith('TRACE_CONTENT_UI_RESULT='));
  assert.ok(resultLine, 'Electron must return Trace UI results');
  const uiResult = JSON.parse(resultLine.slice('TRACE_CONTENT_UI_RESULT='.length));
  assert.equal(uiResult.error, undefined);
  assert.equal(uiResult.passed, 1);

  historyFixtureStore.setTime(new Date(Date.now() + 31 * 24 * 60 * 60 * 1000).toISOString());
  history.cleanup();
  const forgotten = await fetch(`${server.origin}/api/traces/trace-079/content`, { headers });
  assert.equal((await forgotten.json() as {status:string}).status, 'forgotten');
});

test('N079-02 trace content refuses role-mismatched and cross-session History rows without returning text', async t => {
  const historyFixtureStore = historyFixture(300_000_000, 'next079-trace-role-scope');
  t.after(() => historyFixtureStore.cleanup());
  const history = historyFixtureStore.open();
  const scope = { characterId: 'companion' as const, sessionId: 'session-role-check', turnId: 'turn-role-check', generation: 0 };
  history.append(scope, [
    { id: 'turn-role-check:user', characterId: 'companion', role: 'assistant', text: 'assistant-role-secret', createdAt: '2026-09-23T08:00:00.000Z' },
    { id: 'turn-role-check:assistant', characterId: 'companion', role: 'user', text: 'user-role-secret', createdAt: '2026-09-23T08:00:00.000Z' },
  ]);
  const trace: RuntimeTrace = {
    traceId: 'trace-role-check', turnId: scope.turnId, characterId: scope.characterId, sessionId: scope.sessionId,
    userText: '[digest:00000000 len:1]', replyText: '[digest:00000000 len:1]', totalElapsedMs: 1, status: 'ok', stages: [], createdAt: '2026-09-23T08:00:00.000Z',
  };
  const roleMismatch = readTraceContentFromHistory(history, trace);
  assert.equal(roleMismatch.status, 'unavailable');
  assert.doesNotMatch(JSON.stringify(roleMismatch), /assistant-role-secret|user-role-secret/);

  history.append({ ...scope, sessionId: 'other-session', turnId: 'other-turn' }, [
    { id: 'other-turn:user', characterId: 'companion', role: 'user', text: 'other-session-user', createdAt: '2026-09-23T08:00:00.000Z' },
    { id: 'other-turn:assistant', characterId: 'companion', role: 'assistant', text: 'other-session-assistant', createdAt: '2026-09-23T08:00:00.000Z' },
  ]);
  const crossSession = readTraceContentFromHistory(history, { ...trace, sessionId: 'missing-session' });
  assert.equal(crossSession.status, 'unavailable');
  assert.doesNotMatch(JSON.stringify(crossSession), /other-session-user|other-session-assistant/);
});

test('N079-02 legacy plain-text traces and un-sanitized stage details are masked on read and API export', async t => {
  const f = await fixture(t);
  const historyFixtureStore = historyFixture(300_000_000, 'next079-trace-legacy');
  const history = historyFixtureStore.open();
  t.after(() => historyFixtureStore.cleanup());
  const rawDb = history.rawDatabaseForKnowledge();
  const traces = RuntimeTraceStore.open(rawDb);

  // Directly insert a legacy raw row into runtime_traces to simulate old un-sanitized storage
  rawDb.prepare(`
    INSERT INTO runtime_traces (
      trace_id, turn_id, character_id, session_id, user_text, reply_text,
      total_elapsed_ms, status, stages_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'legacy-trace-001', 'turn-legacy-001', 'companion', 'session-legacy-001',
    '历史未脱敏用户正文', '历史未脱敏回复正文',
    100, 'ok',
    JSON.stringify([{
      name: 'distill', label: '记忆提炼', elapsedMs: 15, status: 'ok',
      details: { fact: '未脱敏记忆事实', customSecret: '私密属性' }
    }]),
    '2026-09-22T13:20:00.000Z'
  );

  const listResult = traces.list();
  const legacyTrace = listResult.traces.find(tr => tr.traceId === 'legacy-trace-001');
  assert.ok(legacyTrace, 'legacy trace should be in list');
  assert.match(legacyTrace.userText, /^\[digest:[0-9a-f]{8} len:\d+\]$/, 'userText must be masked on read');
  assert.match(legacyTrace.replyText, /^\[digest:[0-9a-f]{8} len:\d+\]$/, 'replyText must be masked on read');
  assert.match(String(legacyTrace.stages[0]?.details?.['fact']), /^\[digest:[0-9a-f]{8} len:\d+\]$/, 'fact detail must be masked on read');
  assert.doesNotMatch(JSON.stringify(listResult), /历史未脱敏用户正文|历史未脱敏回复正文|未脱敏记忆事实|私密属性/, 'no plaintext in list JSON');

  const got = traces.get('legacy-trace-001');
  assert.ok(got);
  assert.match(got.userText, /^\[digest:[0-9a-f]{8} len:\d+\]$/);
  assert.match(got.replyText, /^\[digest:[0-9a-f]{8} len:\d+\]$/);

  const settings = await ManagementSettingsStore.open(join(f.c.projectRoot, 'settings.json'), f.c);
  const runtime = new ManagementRuntime(f.c.sourceRevision);
  const server = await startManagementServer({
    uiRoot: resolve(root, 'code/desktop-pet/management/ui'), settings,
    memory: {} as never,
    traces,
    traceContent: tr => readTraceContentFromHistory(history, tr),
    snapshot: () => ({ apiVersion: 1, runtime: runtime.identity(), modules: [], events: [], settings: settings.snapshot(), adapters: [], credentials: [], characters: [{ id: 'companion', label: '陪伴者', revision: 0 }] }),
  });
  t.after(() => server.close());
  const headers = { Authorization: `Bearer ${server.token}`, Origin: server.origin };

  const apiList = await fetch(`${server.origin}/api/traces`, { headers });
  assert.equal(apiList.status, 200);
  const listJsonText = await apiList.text();
  assert.doesNotMatch(listJsonText, /历史未脱敏用户正文|历史未脱敏回复正文|未脱敏记忆事实|私密属性/, 'API must not leak plaintext');

  const contentResp = await fetch(`${server.origin}/api/traces/legacy-trace-001/content`, { headers });
  assert.equal(contentResp.status, 200);
  const contentJson = await contentResp.json() as { status: string; reason?: string };
  assert.equal(contentJson.status, 'unavailable');
  assert.match(contentJson.reason ?? '', /没有可验证的历史消息关联/);
});

test('P0 RV-01 sanitizeStageDetails recursively redacts nested objects and arrays in stage details', async () => {
  const { sanitizeStageDetails } = await import('../../core/trace-store.js');

  // Direct isolation test reported in Code Review
  const isolated = sanitizeStageDetails({ items: [{ prompt: 'private sentinel' }] });
  assert.doesNotMatch(JSON.stringify(isolated), /private sentinel/, 'isolated prompt must be redacted');
  assert.match((isolated as any).items[0].prompt, /^\[digest:[0-9a-f]{8} len:16\]$/, 'must have digest format');

  // Deeply nested objects, arrays of arrays, and safe identifiers
  const complex = sanitizeStageDetails({
    status: 'ok',
    elapsedMs: 42,
    affectedIds: ['valid_id-1:v1', 'invalid id with spaces', 'secret_id'],
    prompts: [
      { role: 'user', content: 'nested secret prompt' },
      { role: 'assistant', content: 'nested reply' },
    ],
    nestedArrays: [
      ['deep secret 1', 'deep secret 2'],
      [{ innerText: 'inner array object secret' }],
    ],
    subStage: {
      customSecret: 'sub secret',
      model: 'qwen-turbo',
    },
  });

  const jsonStr = JSON.stringify(complex);
  assert.doesNotMatch(jsonStr, /nested secret prompt|nested reply|deep secret|inner array object secret|sub secret/);
  // Safe metrics and identifiers preserved
  assert.equal((complex as any).status, 'ok');
  assert.equal((complex as any).elapsedMs, 42);
  assert.deepEqual((complex as any).affectedIds, ['valid_id-1:v1', 'secret_id']);
  assert.equal((complex as any).subStage.model, 'qwen-turbo');
  // Sanitized structure preserved
  assert.match((complex as any).prompts[0].content, /^\[digest:[0-9a-f]{8} len:20\]$/);
  assert.match((complex as any).nestedArrays[0][0], /^\[digest:[0-9a-f]{8} len:13\]$/);
  assert.match((complex as any).nestedArrays[1][0].innerText, /^\[digest:[0-9a-f]{8} len:25\]$/);
});
