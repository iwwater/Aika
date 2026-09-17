import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { isOutside, isPrivateFileSync, restrictPrivatePathSync } from '../../dist/core/platform-files.js';
import { assetResponse } from '../../desktop/electron/assets.mjs';
import { fitDisplay } from '../../desktop/electron/layout.mjs';
import { SqliteProjectIndex } from '../../dist/projects/sqlite-project-index.js';
import { FinanceCredentials } from '../../dist/management/balance-credentials.js';
import { managementUrl } from '../../tools/management-url.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'AAAAGENT spaces 中文 '));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
test('Windows containment handles backslashes, sibling prefixes and different drives', () => {
  if (process.platform !== 'win32') return;
  assert.equal(isOutside('C:\\pet', 'C:\\pet\\inside.txt'), false);
  for (const path of ['C:\\pet-other\\file', 'C:\\pet\\..\\file', 'D:\\pet\\file']) assert.equal(isOutside('C:\\pet', path), true);
});
test('owned credentials work with Windows ACLs; a broad read grant is rejected without modifying contents', async t => {
  const dir = await fixture(t), file = join(dir, 'key with 中文.txt');
  await writeFile(file, 'synthetic-key'); restrictPrivatePathSync(file);
  assert.equal(isPrivateFileSync(file), true);
  if (process.platform === 'win32') {
    execFileSync('icacls.exe', [file, '/grant', '*S-1-1-0:R'], { windowsHide: true, stdio: 'pipe' });
    assert.equal(isPrivateFileSync(file), false);
    restrictPrivatePathSync(file); assert.equal(isPrivateFileSync(file), true);
  }
  assert.equal(await readFile(file, 'utf8'), 'synthetic-key');
});
test('finance credentials save and reopen under the Windows private-file policy', async t => {
  const dir = await fixture(t), store = new FinanceCredentials(dir);
  await store.save(0, 'synthetic-id', 'synthetic-secret');
  assert.equal((await new FinanceCredentials(dir).read()).revision, 1);
});
test('project index accepts real Windows paths and persists them, while rejecting traversal and streams', async t => {
  const dir = await fixture(t), file = join(dir, 'index.sqlite'), db = new SqliteProjectIndex(file);
  const saved = await db.save({ expectedVersion: 0, name: 'Windows project', abstract: '', detailRef: { rootPath: dir, entryFile: 'src/main.ts' } });
  await db.close(); const reopened = new SqliteProjectIndex(file);
  try {
  assert.equal((await reopened.list({})).items[0].detailRef.rootPath, dir);
  for (const entryFile of ['../escape', '..\\escape', 'file:stream', 'C:\\outside']) {
    await assert.rejects(reopened.save({ expectedVersion: 0, name: 'bad', abstract: '', detailRef: { rootPath: dir, entryFile } }));
  }
  assert.ok(saved.id); } finally { await reopened.close(); }
});
test('asset protocol serves UTF-8 files and refuses drive paths, ADS, traversal and junction escapes', async t => {
  const dir = await fixture(t), root = join(dir, 'desktop'), outside = join(dir, 'outside');
  await mkdir(root); await mkdir(outside); await writeFile(join(root, '中文.json'), '{"ok":true}'); await writeFile(join(outside, 'secret'), 'synthetic');
  const response = await assetResponse(root, 'pet://app/%E4%B8%AD%E6%96%87.json');
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ok: true });
  for (const path of ['pet://other/中文.json', 'pet://app/C:%5Csecret', 'pet://app/file:stream', 'pet://app/..%5Coutside%5Csecret', 'pet://app/%2Foutside']) assert.notEqual((await assetResponse(root, path)).status, 200);
  await symlink(outside, join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await assetResponse(root, 'pet://app/alias/secret')).status, 403);
});
test('opening the drawer preserves the model position and keeps all bounds on a scaled or negative-origin monitor', () => {
  for (const screen of [{ x: 0, y: 0, width: 1920, height: 1040 }, { x: -1280, y: 0, width: 1280, height: 680 }, { x: 0, y: 0, width: 800, height: 560 }]) {
    const anchor = { x: screen.x + screen.width - 230, y: screen.y + 120 };
    const closed = fitDisplay(360, false, screen, anchor), open = fitDisplay(360, true, screen, closed.anchor);
    assert.deepEqual(open.anchor, closed.anchor);
    assert.ok(open.bounds.x >= screen.x && open.bounds.y >= screen.y);
    assert.ok(open.bounds.x + open.bounds.width <= screen.x + screen.width + 1);
    assert.ok(open.bounds.y + open.bounds.height <= screen.y + screen.height + 1);
  }
});
test('management opener checks authenticated backend identity and never sends tokens to remote hosts', async t => {
  const dir = await fixture(t), file = join(dir, 'management-session.json'), token = 'a'.repeat(64);
  const descriptor = { version: 1, pid: 123, instanceId: 'synthetic', sourceRevision: 'b'.repeat(40), url: 'http://127.0.0.1:12345/#token=' + token };
  await writeFile(file, JSON.stringify(descriptor)); restrictPrivatePathSync(file);
  let calls = 0;
  const fetcher = async (url, options) => { calls++; assert.equal(url, 'http://127.0.0.1:12345/api/snapshot'); assert.equal(options.headers.authorization, 'Bearer ' + token); return Response.json({ runtime: descriptor }); };
  assert.equal(await managementUrl(join(dir, 'config.json'), fetcher), descriptor.url);
  await writeFile(file, JSON.stringify({ ...descriptor, url: 'https://example.com/#token=' + token }));
  await assert.rejects(managementUrl(join(dir, 'config.json'), fetcher)); assert.equal(calls, 1);
});
