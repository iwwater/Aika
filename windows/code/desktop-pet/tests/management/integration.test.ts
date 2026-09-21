import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, copyFile, cp, symlink, writeFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fixture } from './helpers.js';
import { SqliteMemoryStore, CONFIRMED_RETENTION } from '../../memory/sqlite-store.js';
import { SqliteManagementMemoryPort } from '../../memory/management-port.js';
import { confirmedInvitationPolicy } from '../../companion/invitations.js';
import { ManagementSettingsStore } from '../../management/settings-store.js';
import { ManagementRuntime } from '../../management/runtime.js';
import { startRuntimeManagement } from '../../management/bootstrap.js';
import { lifecycle } from '../memory/lifecycle-fixture.js';
import { scope, seed, NOW } from '../memory/sqlite-fixture.js';

test('actual HTTP management edits the injected SQLite store, invalidates context and survives reopen without provider calls', async t => {
  const f = await fixture(t);
  const uiRoot = join(f.c.projectRoot, 'code/desktop-pet/management/ui'); await mkdir(uiRoot, { recursive: true });
  const assets = ['index.html', 'app.mjs', 'api.mjs', 'dom.mjs', 'views.mjs', 'style.css'];
  for (const asset of assets) await copyFile(resolve(dirname(fileURLToPath(import.meta.url)), '../../../management/ui', asset), join(uiRoot, asset));
  let store = new SqliteMemoryStore({ filename: f.c.database, retention: CONFIRMED_RETENTION, invitations: confirmedInvitationPolicy('Asia/Shanghai'), clock: () => NOW });
  t.after(() => store.close());
  seed(store);
  for (const kind of ['summary', 'keyword_index', 'vector_index', 'context_cache'] as const)
    store.recordDerived(scope(), { id: kind, kind, text: '海风公司旧派生', sourceIds: ['job'], createdAt: NOW });
  let providerCalls = 0;
  const memory = lifecycle(store, async () => { providerCalls++; throw new Error('No management provider call'); },
    async () => { providerCalls++; throw new Error('No management provider call'); });
  const port = new SqliteManagementMemoryPort(store, memory), runtime = new ManagementRuntime(f.c.sourceRevision);
  const settings = await ManagementSettingsStore.open(join(f.c.projectRoot, 'settings.json'), f.c);
  const server = await startRuntimeManagement(f.c, f.configFile, settings, runtime, port);
  t.after(() => server.close().catch(() => {}));
  const headers = { Authorization: 'Bearer ' + server.token, Origin: server.origin, 'Content-Type': 'application/json' };
  const get = (path: string) => fetch(server.origin + path, { headers });
  for (const asset of assets) {
    const result = await get('/' + asset); assert.equal(result.status, 200);
    assert.equal(await result.text(), await readFile(join(uiRoot, asset), 'utf8'));
  }
  const revisionBeforeReads = store.revision(scope());
  for (const path of ['/api/snapshot', '/api/prompt?characterId=companion', '/api/records?characterId=companion&kind=memory', '/api/context?characterId=companion&query=工作'])
    assert.equal((await get(path)).status, 200);
  assert.equal(store.revision(scope()), revisionBeforeReads); assert.equal(providerCalls, 0);
  const oldContext = await memory.context(scope(), '工作', null, new AbortController().signal);
  const edit = { characterId: 'companion', id: 'job', expectedVersion: 1, operationId: 'web-edit', text: '现在在山川公司工作', reason: 'synthetic user edit' };
  const postEdit = (data: typeof edit) => fetch(server.origin + '/api/records/edit', { method: 'POST', headers, body: JSON.stringify(data) });
  const response = await postEdit(edit); assert.equal(response.status, 200);
  const saved = await response.json() as { record: { version: number; origin: string }; invalidatedIds: string[] };
  assert.equal(saved.record.version, 2); assert.equal(saved.record.origin, 'manual');
  assert.ok(['summary', 'keyword_index', 'vector_index', 'context_cache'].every(id => saved.invalidatedIds.includes(id)));
  assert.equal(store.search(scope(), '山川公司', 10)[0]!.id, 'job');
  assert.equal(store.search(scope(), '海风公司', 10).length, 0);
  assert.throws(() => memory.assertContextCurrent(oldContext), /stale_context/);
  assert.equal((await postEdit({ ...edit, operationId: 'stale-tab' })).status, 409);
  assert.equal((await postEdit(edit)).status, 200);
  const context = await (await get('/api/context?characterId=companion&query=山川公司')).json() as { memories: { text: string; origin: string }[] };
  assert.equal(context.memories[0]!.text, edit.text); assert.equal(context.memories[0]!.origin, 'manual');
  assert.equal((await get('/api/context?characterId=sweetheart&query=海风公司')).status,400);
  assert.throws(()=>store.search(scope('sweetheart'),'海风公司',10),/unknown_character/);
  const prompt = await (await get('/api/prompt?characterId=companion')).json() as { revision: number };
  const body = JSON.stringify({ characterId: 'companion', expectedRevision: prompt.revision, text: '人工设置的角色提示', operationId: 'prompt-web-edit' });
  assert.equal((await fetch(server.origin + '/api/prompt', { method: 'PUT', headers, body })).status, 200);
  assert.equal((await fetch(server.origin + '/api/prompt', { method: 'PUT', headers, body: JSON.stringify({ characterId: 'companion', expectedRevision: prompt.revision, text: 'stale', operationId: 'prompt-stale' }) })).status, 409);
  assert.equal((await port.context('companion', '')).prompt, '人工设置的角色提示');
  const descriptor = JSON.parse(await readFile(join(f.c.projectRoot, 'management-session.json'), 'utf8'));
  assert.equal(descriptor.instanceId, runtime.instanceId); assert.equal(descriptor.pid, process.pid);
  await server.close();
  await assert.rejects(readFile(join(f.c.projectRoot, 'management-session.json')), /ENOENT/);
  store.close();
  store = new SqliteMemoryStore({ filename: f.c.database, retention: CONFIRMED_RETENTION, invitations: confirmedInvitationPolicy('Asia/Shanghai'), clock: () => NOW });
  const reopened = new SqliteManagementMemoryPort(store, lifecycle(store));
  assert.equal((await reopened.context('companion', '山川公司')).memories[0]!.text, edit.text);
  assert.equal(reopened.prompt('companion').text, '人工设置的角色提示'); assert.equal(providerCalls, 0);
  // FIX61-10: t.after hooks run in registration order — the fixture rm (registered first) runs before
  // these closes, and on Windows it deletes an open SQLite file (EBUSY). Close explicitly here; the
  // after-hooks remain for the failure paths and are idempotent.
  await server.close(); store.close();
  (reopened as unknown as { store: { close(): void } }).store.close();
});

test('actual trial backend process publishes its local page, applies saved configuration only after restart and exits cleanly', async t => {
  const f = await fixture(t), source = resolve(dirname(fileURLToPath(import.meta.url)), '../../..'), project = join(f.c.projectRoot, 'code/desktop-pet');
  await mkdir(project, { recursive: true });
  await cp(join(source, 'dist'), join(project, 'dist'), { recursive: true });
  await cp(join(source, 'management/ui'), join(project, 'management/ui'), { recursive: true });
  await cp(join(source, 'desktop/assets/local-model'), join(project, 'desktop/assets/local-model'), { recursive: true });
  await cp(join(source, 'desktop/vendor/cubism'), join(project, 'desktop/vendor/cubism'), { recursive: true });
  // Isolated runtime fixture reuses installed dependencies; no native process/device is launched.
  await symlink(join(source, 'node_modules'), join(project, 'node_modules'));
  await writeFile(join(project, 'package.json'), '{"type":"module"}');
  const hash = (raw: string | Buffer) => createHash('sha256').update(raw).digest('hex');
  const runtimeFiles: Record<string, string> = {};
  for (const path of Object.keys(f.c.runtimeFiles)) {
    const destination = join(f.c.projectRoot, path); await mkdir(dirname(destination), { recursive: true });
    if (path.includes('/desktop/')) await copyFile(join(source, path.slice('code/desktop-pet/'.length)), destination);
    runtimeFiles[path] = hash(await readFile(destination));
  }
  const config = { ...f.c, runtimeFiles }, raw = JSON.stringify(config);
  await writeFile(f.configFile, raw);
  await writeFile(f.activationFile, JSON.stringify({ version: 1, status: 'active', phaseId: config.phaseId, configSha256: hash(raw) }));
  const ledgerBefore = await readFile(config.budgetFile, 'utf8');
  const descriptor = join(f.c.projectRoot, 'management-session.json');
  const start = async () => {
    const child = spawn(process.execPath, [join(project, 'dist/app/trial-backend.js')], { env: { ...process.env, PET_TRIAL_CONFIG: f.configFile, PET_TRIAL_ACTIVATION: f.activationFile }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '', stdout = ''; child.stderr.on('data', chunk => { stderr += String(chunk); }); child.stdout.on('data', chunk => { stdout += String(chunk); });
    const exited = new Promise<number | null>(done => child.once('exit', done));
    t.after(async () => { if (child.exitCode === null) { child.stdin.end(); await exited; } });
    const end = Date.now() + 5000;
    while (Date.now() < end) {
      try {
        const session = JSON.parse(await readFile(descriptor, 'utf8'));
        if (session.pid === child.pid) {
          const url = new URL(session.url), headers = { Authorization: 'Bearer ' + url.hash.slice(7), Origin: url.origin, 'Content-Type': 'application/json' };
          return { child, exited, url, headers, messages: () => stdout.split('\n').filter(Boolean).map(line => JSON.parse(line)) };
        }
      } catch {}
      if (child.exitCode !== null) throw new Error('Isolated backend failed: ' + stderr);
      await new Promise(done => setTimeout(done, 20));
    }
    throw new Error('Isolated backend did not publish its descriptor');
  };
  const first = await start();
  const initial = first.messages();
  // FIX61-03: startup progress records now precede backend_ready on stdout; ready is still present.
  assert.equal(initial.at(-1)?.channel, 'backend_ready');
  assert.ok(initial.slice(0, -1).every(m => m.channel === 'backend_startup'),
    'only startup progress may precede backend_ready: ' + JSON.stringify(initial.map(m => m.channel)));
  assert.equal(initial.find(m => m.channel === 'presentation_policy').policy.enabledIds.length, 13);
  const presentationResponse = await fetch(first.url.origin + '/api/presentation', { headers: first.headers });
  const presentation = await presentationResponse.json() as { catalog: { modelId: string }; policy: { revision: number } };
  const policySaved = await fetch(first.url.origin + '/api/presentation', { method: 'PUT', headers: first.headers,
    body: JSON.stringify({ modelId: presentation.catalog.modelId, expectedRevision: presentation.policy.revision, enabledIds: [] }) });
  assert.equal(policySaved.status, 200);
  await new Promise(done => setTimeout(done, 20));
  assert.deepEqual(first.messages().filter(m => m.channel === 'presentation_policy').at(-1).policy.enabledIds, []);
  const snapshot = await (await fetch(first.url.origin + '/api/snapshot', { headers: first.headers })).json() as { runtime: { pid: number }; settings: { saved: import('../../contracts/management.js').ManagedSettings; revision: number; effectiveRevision: number } };
  assert.equal(snapshot.runtime.pid, first.child.pid);
  snapshot.settings.saved.context.maxRecentMessages = 7; snapshot.settings.saved.providers.tts.voice = 'Serena';
  const result = await fetch(first.url.origin + '/api/settings', { method: 'PUT', headers: first.headers, body: JSON.stringify({ expectedRevision: 0, settings: snapshot.settings.saved }) });
  assert.equal(result.status, 200);
  const saved = await result.json() as { pending: boolean; effectiveRevision: number }; assert.equal(saved.pending, true); assert.equal(saved.effectiveRevision, 0);
  first.child.stdin.end(); assert.equal(await first.exited, 0); await assert.rejects(readFile(descriptor), /ENOENT/);
  const second = await start();
  assert.deepEqual(second.messages().find(m => m.channel === 'presentation_policy').policy.enabledIds, []);
  assert.equal(second.messages().find(m => m.channel === 'presentation_policy').policy.revision, 1);
  const next = await (await fetch(second.url.origin + '/api/snapshot', { headers: second.headers })).json() as { settings: { effective: import('../../contracts/management.js').ManagedSettings; pending: boolean; effectiveRevision: number } };
  assert.equal(next.settings.pending, false); assert.equal(next.settings.effectiveRevision, 1);
  assert.equal(next.settings.effective.providers.tts.voice, 'Serena'); assert.equal(next.settings.effective.context.maxRecentMessages, 7);
  second.child.stdin.end(); assert.equal(await second.exited, 0);
  assert.equal(await readFile(config.budgetFile, 'utf8'), ledgerBefore);
  assert.equal(await readFile(f.configFile, 'utf8'), raw);
});
