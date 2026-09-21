import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { isPrivateFileSync } from '../../core/platform-files.js';
import { mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { fixture } from './helpers.js';
import { ManagementSettingsStore } from '../../management/settings-store.js';
import { ManagementRuntime } from '../../management/runtime.js';
import { startRuntimeManagement } from '../../management/bootstrap.js';
import type { ManagementMemoryPort } from '../../contracts/management.js';

test('actual management bootstrap preserves companion/ledger bytes and separate index/receipts across restart', async t => {
  const f = await fixture(t);
  // FIX61-10: the companion data directory is where the bootstrap actually stores the companion
  // database (dirname of the configured database), not a hardcoded port-era layout path; the index
  // and receipts must live beside it, separate from the companion bytes themselves.
  const directory = dirname(f.c.database); await mkdir(directory, { recursive: true });
  const protectedFile = join(directory, 'companion.sqlite'); await writeFile(protectedFile, 'Synthetic companion and prompt sentinel');
  const protectedBefore = await readFile(protectedFile), ledgerBefore = await readFile(f.c.budgetFile);
  const settings = await ManagementSettingsStore.open(join(f.c.projectRoot, 'synthetic-settings.json'), f.c);
  const reject = (): never => { throw Error('Companion port must not be used by independent project routes'); };
  const memory: ManagementMemoryPort = { characters: () => [], list: reject, edit: reject, context: reject, prompt: reject, savePrompt: reject };
  const fetchOriginal = globalThis.fetch; let origin = '';
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => { assert.ok(String(input).startsWith(origin + '/api/projects')); return fetchOriginal(input, init); }) as typeof fetch;
  t.after(() => { globalThis.fetch = fetchOriginal; });
  let active: Awaited<ReturnType<typeof startRuntimeManagement>> | undefined;
  t.after(async () => { await active?.close(); });
  const start = async () => { const server = await startRuntimeManagement(f.c, f.configFile, settings, new ManagementRuntime(f.c.sourceRevision), memory); origin = server.origin; active = server; return server; };
  const first = await start();
  const saved = await fetch(first.origin + '/api/projects/save', { method: 'POST', headers: { Authorization: 'Bearer ' + first.token, Origin: first.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedVersion: 0, name: 'Persisted index', abstract: 'Small reference only', detailRef: { rootPath: f.c.projectRoot } }) });
  assert.equal(saved.status, 200); const entry = await saved.json(); await first.close(); active = undefined;
  const indexFile = join(directory, 'project-index.sqlite'), receiptsFile = join(directory, 'harness-relay.sqlite');
  const indexBefore = await readFile(indexFile), receiptsBefore = await readFile(receiptsFile);
  // FIX61-10: private means "owner only" per platform — POSIX mode bits, or a checked SID-based ACL
  // on Windows (mode bits are a no-op there and libuv reports 0o666). The ACL guarantee is the one
  // restrictPrivatePathSync creates and isPrivateFileSync verifies, so assert exactly that.
  if (process.platform === 'win32') { assert.equal(isPrivateFileSync(indexFile), true); assert.equal(isPrivateFileSync(receiptsFile), true); }
  else { assert.equal((await stat(indexFile)).mode & 0o077, 0); assert.equal((await stat(receiptsFile)).mode & 0o077, 0); }
  const second = await start();
  const restored = await fetch(second.origin + '/api/projects/' + entry.id, { headers: { Authorization: 'Bearer ' + second.token } });
  assert.equal(restored.status, 200); assert.deepEqual(await restored.json(), entry); await second.close(); active = undefined;
  assert.deepEqual(await readFile(protectedFile), protectedBefore); assert.deepEqual(await readFile(f.c.budgetFile), ledgerBefore);
  assert.deepEqual(await readFile(indexFile), indexBefore); assert.deepEqual(await readFile(receiptsFile), receiptsBefore);
});
