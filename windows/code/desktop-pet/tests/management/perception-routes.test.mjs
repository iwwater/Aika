import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { perceptionRoute } from '../../dist/management/perception-routes.js';
import { startManagementServer } from '../../dist/management/server.js';
import { ManagementSettingsStore } from '../../dist/management/settings-store.js';
import { ManagementRuntime } from '../../dist/management/runtime.js';
import { fixture } from '../../dist/tests/management/helpers.js';

const observation = { observationId: 'obs-a', pairing: { userId: 'u', characterId: 'companion', characterInstanceId: 'companion-default' },
  grantId: 'grant-a', grantRevision: 1, frameHash: 'a'.repeat(64), capturedAt: new Date().toISOString(),
  vlm: { status: 'ok', summary: '当前页面', visualElements: [], rawExcluded: true }, state: 'active', ttlMs: 120000 };
function fakePort() {
  const calls = [];
  return { calls, port: {
    status: () => ({ enabled: true, capabilities: { cloud: true } }),
    issue: input => { calls.push(['issue', input]); return { grantId: 'grant-a', ...input }; },
    capture: async input => { calls.push(['capture', input]); return observation; },
    attach: (...args) => calls.push(['attach', ...args]),
    revoke: id => ({ revoked: id === 'grant-a' }),
    clear: id => ({ cleared: id === 'obs-a' }),
  } };
}

test('08-03 authenticated perception route contract covers explicit grant, capture, attach, revoke and clear', async () => {
  const { port, calls } = fakePort();
  const response = [];
  const send = value => response.push(value);
  const body = value => async () => value;
  assert.equal(await perceptionRoute('GET', port, '/api/perception', body({}), send), true);
  assert.equal(response[0].capabilities.cloud, true);
  await assert.rejects(perceptionRoute('POST', port, '/api/perception/grants', body({ scopeType: 'window', destination: 'cloud' }), send), /确认/);
  await perceptionRoute('POST', port, '/api/perception/grants', body({ scopeType: 'window', destination: 'cloud', userConfirmed: true }), send);
  assert.equal(calls[0][1].userConfirmed, true);
  await perceptionRoute('POST', port, '/api/perception/captures', body({ grantId: 'grant-a', mimeType: 'image/png', imageBase64: 'AA==' }), send);
  assert.equal(calls[1][1].imageBase64, 'AA==');
  await perceptionRoute('POST', port, '/api/perception/attach', body({ observationId: 'obs-a', userConfirmed: true }), send);
  assert.equal(calls[2][0], 'attach');
  assert.deepEqual(await (async () => { let value; await perceptionRoute('DELETE', port, '/api/perception/grants/grant-a', body({}), x => { value = x; }); return value; })(), { revoked: true });
  assert.deepEqual(await (async () => { let value; await perceptionRoute('DELETE', port, '/api/perception/observations/obs-a', body({}), x => { value = x; }); return value; })(), { cleared: true });
  await assert.rejects(perceptionRoute('GET', undefined, '/api/perception', body({}), send), /未装配/);
});

test('08-03 perception routes are same-origin authenticated and enforce confirmations over HTTP', async t => {
  const f = await fixture(t), uiRoot = join(f.c.projectRoot, 'ui');
  await mkdir(uiRoot); await writeFile(join(uiRoot, 'index.html'), '<h1>fixture</h1>');
  const settings = await ManagementSettingsStore.open(join(f.c.projectRoot, 'settings.json'), f.c);
  const calls = [];
  const perception = {
    status: () => ({ enabled: true, capabilities: { cloud: true } }),
    issue: value => { calls.push(['issue', value]); return { grantId: 'grant-http' }; },
    capture: async value => { calls.push(['capture', value]); return observation; },
    attach: (...values) => calls.push(['attach', ...values]),
    revoke: id => { calls.push(['revoke', id]); return { revoked: true }; },
    clear: id => { calls.push(['clear', id]); return { cleared: true }; },
  };
  const runtime = new ManagementRuntime(f.c.sourceRevision);
  const server = await startManagementServer({ uiRoot, settings, memory: {
    characters: () => [], list: query => ({ ...query, revision: 0, records: [], total: 0 }),
    edit() { throw new Error(); }, context() { throw new Error(); }, prompt() { throw new Error(); }, savePrompt() { throw new Error(); },
  }, snapshot: () => ({ apiVersion: 1, runtime: runtime.identity(), modules: runtime.modules(), events: [],
    settings: settings.snapshot(), adapters: [], credentials: [], characters: [] }), perception });
  t.after(() => server.close());
  const headers = { Authorization: `Bearer ${server.token}`, Origin: server.origin, 'Content-Type': 'application/json' };
  assert.equal((await fetch(server.origin + '/api/perception')).status, 401);
  assert.equal((await fetch(server.origin + '/api/perception', { headers })).status, 200);
  const grantBody = { scopeType: 'window', destination: 'cloud' };
  assert.equal((await fetch(server.origin + '/api/perception/grants', { method: 'POST', headers, body: JSON.stringify(grantBody) })).status, 403);
  const granted = await fetch(server.origin + '/api/perception/grants', { method: 'POST', headers,
    body: JSON.stringify({ ...grantBody, userConfirmed: true }) });
  assert.equal(granted.status, 200);
  assert.equal(calls[0][1].userConfirmed, true);
  assert.equal((await fetch(server.origin + '/api/perception/attach', { method: 'POST', headers,
    body: JSON.stringify({ observationId: 'obs-a' }) })).status, 403);
  assert.equal((await fetch(server.origin + '/api/perception/attach', { method: 'POST', headers,
    body: JSON.stringify({ observationId: 'obs-a', userConfirmed: true }) })).status, 200);
  assert.equal((await fetch(server.origin + '/api/perception/captures', { method: 'POST', headers,
    body: JSON.stringify({ grantId: 'grant-http', mimeType: 'image/png', imageBase64: 'AA==' }) })).status, 200);
  assert.deepEqual(calls.map(call => call[0]), ['issue', 'attach', 'capture']);
});
