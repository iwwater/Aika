import test from 'node:test';
import assert from 'node:assert/strict';
import { startManagementServer } from '../../management/server.js';
import { ManagementError, type ManagementMemoryPort, type ManagementSnapshot } from '../../contracts/management.js';
import type { ManagementSettingsStore } from '../../management/settings-store.js';
import type { MemoryImportManagement, MemoryImportJob } from '../../contracts/memory-import.js';

test('import HTTP rejects unauthorized, cross-origin and cross-role input before source discovery; sanitizes failures', async t => {
  let reads = 0, starts = 0;
  const job = { id: 'job', revision: 1 } as MemoryImportJob;
  const port: MemoryImportManagement = {
    snapshot() { reads++; return { instanceId: 'current', configuration: {} as never, jobs: [] }; },
    start(input) { starts++; if(input.instanceId !== 'current') throw new ManagementError('version_conflict','实例已更换。'); return job; },
    pause() { throw new Error('PRIVATE old conversation'); }, resume() { return job; }, close() {},
  };
  const server = await startManagementServer({ memoryImport: port, uiRoot: '/nonexistent',
    settings: { async drain() {} } as unknown as ManagementSettingsStore, memory: {} as ManagementMemoryPort,
    snapshot: () => ({} as ManagementSnapshot) });
  t.after(() => server.close());
  const headers = { Authorization: 'Bearer ' + server.token, Origin: server.origin, 'Content-Type': 'application/json' };
  const input = { instanceId: 'current', operationId: 'once', characterId: 'companion', source: { kind: 'codex-project', projectName: 'synthetic', path: '/synthetic' } };
  const post = (suffix: string, value: unknown, h = headers) => fetch(server.origin + '/api/memory-import/' + suffix, { method: 'POST', headers: h, body: JSON.stringify(value) });
  assert.equal((await fetch(server.origin + '/api/memory-import')).status, 401);
  assert.equal(reads, 0);
  assert.equal((await post('start', input, { ...headers, Origin: 'https://foreign.invalid' })).status, 403);
  assert.equal((await post('start', { ...input, characterId: 'other' })).status, 400);
  assert.equal((await post('start', { ...input, source: { ...input.source, kind: 'web' } })).status, 400);
  assert.equal((await post('start', { ...input, operationId: '' })).status, 400);
  assert.equal(starts, 0);
  assert.equal((await post('start', { ...input, instanceId: 'obsolete' })).status, 409);
  assert.equal((await post('start', input)).status, 200);
  assert.equal((await fetch(server.origin + '/api/memory-import', { headers })).status, 200);
  assert.equal(reads, 1);
  assert.equal((await post('pause', { instanceId: 'current', jobId: 'job', expectedRevision: 0 })).status, 400);
  const failed = await post('pause', { instanceId: 'current', jobId: 'job', expectedRevision: 1 });
  assert.equal(failed.status, 500); assert.equal((await failed.text()).includes('PRIVATE'), false);
  // FIX61-10: close explicitly before the after-hook. Tearing the server down inside process
  // teardown trips a libuv assertion on Windows (uv_close during exit); an explicit, idempotent
  // close here keeps the crash path out of the run.
  await server.close();
});
