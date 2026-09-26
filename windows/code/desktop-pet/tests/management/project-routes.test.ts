import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fixture } from './helpers.js';
import { startManagementServer } from '../../management/server.js';
import { ManagementSettingsStore } from '../../management/settings-store.js';
import { ManagementRuntime } from '../../management/runtime.js';
import { ManagementError, type ManagementMemoryPort } from '../../contracts/management.js';
import type { ProjectEntry, ProjectIndexPort } from '../../contracts/projects.js';

test('project HTTP routes retain auth, Origin and revision checks without invoking companion memory', async t => {
  const f = await fixture(t), settings = await ManagementSettingsStore.open(join(f.c.projectRoot, 'settings.json'), f.c);
  const runtime = new ManagementRuntime(f.c.sourceRevision);
  let calls = 0;
  let item: ProjectEntry | null = { id: 'project-test', name: 'Synthetic project', abstract: 'Short reference', detailRef: { rootPath: '/synthetic-project', entryFile: 'AGENTS.md' }, version: 1, updatedAt: '2026-09-14T00:00:00Z' };
  const memory: ManagementMemoryPort = { characters: () => [], list() { throw Error('companion memory must not be read'); }, edit() { throw Error(); }, context() { throw Error(); }, prompt() { throw Error(); }, savePrompt() { throw Error(); } };
  const projects: ProjectIndexPort = {
    async list(q) { calls++; return { items: item ? [item] : [], total: item ? 1 : 0, offset: q.offset!, limit: q.limit! }; },
    async get(id) { calls++; return item?.id === id ? item : null; },
    async save(input) { calls++; if (input.expectedVersion !== item?.version) throw new ManagementError('version_conflict', '请刷新项目后核对。'); item = { ...item, ...input, id: 'project-test', version: item.version + 1 }; return item; },
    async remove(id, version) { calls++; if (item?.version !== version) throw new ManagementError('version_conflict', '版本已变化。'); item = null; return { id, removed: true }; },
    async close() {},
  };
  const server = await startManagementServer({ uiRoot: f.c.projectRoot, settings, memory, projects,
    snapshot: () => ({ apiVersion: 1, runtime: runtime.identity(), modules: [], events: [], settings: settings.snapshot(), adapters: [], credentials: [], characters: [] }) });
  t.after(() => server.close());
  const headers = { Authorization: 'Bearer ' + server.token, Origin: server.origin, 'Content-Type': 'application/json' };
  assert.equal((await fetch(server.origin + '/api/projects')).status, 401); assert.equal(calls, 0);
  assert.equal((await fetch(server.origin + '/api/projects/save', { method: 'POST', headers: { ...headers, Origin: 'https://foreign.invalid' }, body: '{}' })).status, 403); assert.equal(calls, 0);
  assert.equal((await fetch(server.origin + '/api/projects?limit=0', { headers })).status, 400); assert.equal(calls, 0);
  const list = await fetch(server.origin + '/api/projects', { headers }); assert.equal(list.status, 200);
  assert.equal((await list.json()).items[0].name, 'Synthetic project');
  assert.equal((await fetch(server.origin + '/api/projects/project-test', { headers })).status, 200);
  assert.equal((await fetch(server.origin + '/api/projects/%2Fetc%2Fpasswd', { headers })).status, 400);
  const save = (version: number) => fetch(server.origin + '/api/projects/save', { method: 'POST', headers, body: JSON.stringify({ ...item, expectedVersion: version, name: 'Renamed' }) });
  assert.equal((await save(1)).status, 200); assert.equal((await save(1)).status, 409);
  assert.equal((await fetch(server.origin + '/api/projects/remove', { method: 'POST', headers, body: JSON.stringify({ id: 'project-test', expectedVersion: 2 }) })).status, 200);
  assert.equal((await fetch(server.origin + '/api/projects/project-test', { headers })).status, 404);
});
