import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture } from '../management/helpers.js';
import { startManagementServer } from '../../management/server.js';
import { ManagementSettingsStore } from '../../management/settings-store.js';
import { ManagementRuntime } from '../../management/runtime.js';
import type { ManagementMemoryPort } from '../../contracts/management.js';
import { ForwardReceipts } from '../../harness/receipts.js';
import { HarnessForwarding } from '../../harness/forwarding.js';
import { SqliteProjectIndex } from '../../projects/sqlite-project-index.js';

test('real HTTP, isolated SQLite and stdio MCP preserve one confirmation and immutable delivery', async t => {
  const f = await fixture(t), root = f.c.projectRoot;
  const settings = await ManagementSettingsStore.open(join(root, 'settings.json'), f.c);
  const runtime = new ManagementRuntime(f.c.sourceRevision), projects = new SqliteProjectIndex(join(root, 'project-index.sqlite'));
  const protectedFile = join(root, 'companion.sqlite'); await writeFile(protectedFile, 'Synthetic companion sentinel');
  const projectRoot = join(root, 'selected-project'); await mkdir(projectRoot); await writeFile(join(projectRoot, 'AGENTS.md'), 'PRIVATE PROJECT BODY MUST NOT BE READ BY RELAY');
  let hostCalls = 0, completed = false; const sends: string[] = [], threadId = randomUUID(), turnId = randomUUID();
  const tasks = new HarnessForwarding({ projects, receipts: new ForwardReceipts(join(root, 'harness-relay.sqlite')),
    presetId: 'desktop-pet-relay-v1', workspace: root, compatible: async () => true, presetReady: async () => true,
    harness: { async probe() { return { state: 'ready', observedAt: 'now', codexDelivery: 'unverified' }; }, async createRelaySession() { hostCalls++; }, async submitConfirmedOperation() { hostCalls++; } },
    codex: { list: () => [{ threadId, hostId: 'local', title: 'Synthetic existing task', projectPath: projectRoot }], discover: async () => ({ available: true }),
      async send(target, text) { assert.equal(target, threadId); sends.push(text); return { threadId, turnId, requestId: randomUUID() }; },
      async receipt(target, turn) { assert.equal(target, threadId); assert.equal(turn, turnId); return { threadId, turnId, status: completed ? 'completed' : 'unknown', reply: '<script>synthetic engineering reply</script>' }; } },
  });
  const memory: ManagementMemoryPort = { characters: () => [], list() { throw Error('No companion access'); }, edit() { throw Error(); }, context() { throw Error(); }, prompt() { throw Error(); }, savePrompt() { throw Error(); } };
  const server = await startManagementServer({ uiRoot: root, settings, memory, projects, tasks,
    snapshot: () => ({ apiVersion: 1, runtime: runtime.identity(), modules: [], events: [], settings: settings.snapshot(), adapters: [], credentials: [], characters: [] }) });
  t.after(async () => { await server.close(); await tasks.close(); await projects.close(); });
  const headers = { Authorization: 'Bearer ' + server.token, Origin: server.origin, 'Content-Type': 'application/json' };
  const post = (path: string, body: unknown) => fetch(server.origin + path, { method: 'POST', headers, body: JSON.stringify(body) });
  assert.equal((await fetch(server.origin + '/api/tasks')).status, 401);
  assert.equal((await fetch(server.origin + '/api/harness-tools/send-confirmed', { method: 'POST', headers: { ...headers, Origin: 'https://foreign.invalid' }, body: '{}' })).status, 403);
  const saved = await post('/api/projects/save', { expectedVersion: 0, name: 'Synthetic project', abstract: 'Only a small index', detailRef: { rootPath: projectRoot, entryFile: 'AGENTS.md' } });
  assert.equal(saved.status, 200); const project = await saved.json();
  assert.equal((await projects.get(project.id))?.name, 'Synthetic project');
  const prepared = await post('/api/tasks/prepare', { text: 'Original confirmed engineering task', target: { threadId, hostId: 'local' }, projectId: project.id, projectVersion: 1 });
  assert.equal(prepared.status, 200); const operation = await prepared.json();
  const descriptor = join(root, 'management-session.json');
  await writeFile(descriptor, JSON.stringify({ url: server.origin + '/#token=' + server.token }), { mode: 0o600 });
  const child = spawn(process.execPath, [resolve('tools/harness-relay-mcp.mjs'), descriptor], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(async () => { if (child.exitCode === null) { child.kill(); await once(child, 'exit'); } });
  let buffer = '', sequence = 0;
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  child.stdout.setEncoding('utf8'); child.stdout.on('data', data => { buffer += data; while (buffer.includes('\n')) { const end = buffer.indexOf('\n'), value = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); const call = pending.get(value.id); if (call) { clearTimeout(call.timer); pending.delete(value.id); call.resolve(value); } } });
  const rpc = (method: string, params: unknown = {}) => new Promise<any>((resolve, reject) => { const id = ++sequence; const timer = setTimeout(() => { pending.delete(id); reject(Error('MCP timeout')); }, 3000); pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  const init = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'isolated-test', version: '1' } });
  assert.equal(init.result.protocolVersion, '2025-03-26');
  const catalogue = (await rpc('tools/list')).result.tools;
  assert.deepEqual(catalogue.map((x: any) => x.name), ['send_confirmed', 'status']);
  assert.ok(catalogue.every((x: any) => x.inputSchema.additionalProperties === false));
  const tool = (name: string, args = { operationId: operation.id }) => rpc('tools/call', { name, arguments: args });
  assert.equal((await tool('send_confirmed')).result.isError, true); assert.equal(hostCalls, 0);
  assert.equal((await tool('bash')).result.isError, true);
  assert.equal((await tool('send_confirmed', { operationId: operation.id, text: 'Rewrite', target: randomUUID() } as any)).result.isError, true);
  const confirmation = await post('/api/tasks/confirm', { id: operation.id, expectedVersion: 1 }); assert.equal(confirmation.status, 200);
  assert.equal(hostCalls, 0); assert.equal(sends.length, 1);
  const [first, repeat] = await Promise.all([tool('send_confirmed'), tool('send_confirmed')]);
  assert.equal(sends.length, 1); assert.equal(sends[0], 'Original confirmed engineering task');
  assert.ok(!sends[0]!.includes(projectRoot)); assert.ok(!sends[0]!.includes('PRIVATE PROJECT BODY'));
  assert.ok(!JSON.stringify([first, repeat]).includes('Original confirmed engineering task'));
  assert.equal((await post('/api/tasks/confirm', { id: operation.id, expectedVersion: 1 })).status, 200); assert.equal(hostCalls, 0);
  completed = true; const status = JSON.parse((await tool('status')).result.content[0].text);
  assert.equal(status.status, 'completed'); assert.equal(status.turnId, turnId); assert.equal(status.result, '<script>synthetic engineering reply</script>');
  assert.equal((await readFile(protectedFile, 'utf8')), 'Synthetic companion sentinel');
  assert.equal((await readFile(f.c.budgetFile, 'utf8')).includes('historical-settled'), true);
});
