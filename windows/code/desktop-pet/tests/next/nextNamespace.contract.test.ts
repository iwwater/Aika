// NEXT-02 contract tests: the Next data namespace never touches the Legacy/AAAAGENT directories.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { legacyUserDataDir, legacyUserDataRoot, nextUserDataDir, nextUserDataRoot } from '../../core/next-namespace.js';

test('Next and legacy/AAAAGENT data roots are different and non-nested', () => {
  const appData = resolve('/tmp-fake', 'AppData');
  assert.equal(nextUserDataRoot(appData), resolve(appData, 'AikaNext'));
  assert.equal(legacyUserDataRoot(appData), resolve(appData, 'AAAAGENT'));
  assert.notEqual(nextUserDataRoot(appData), legacyUserDataRoot(appData));
  assert.equal(nextUserDataDir(appData, 'smoke-test'), resolve(appData, 'AikaNext', 'smoke-test'));
  assert.equal(nextUserDataDir(appData, 'desktop'), resolve(appData, 'AikaNext', 'desktop'));
  const inside = relative(legacyUserDataRoot(appData), nextUserDataRoot(appData));
  assert.ok(inside.startsWith('..'), 'the Next root must not live inside the legacy root');
});

test('sentinel files in legacy/AAAAGENT directories stay byte-identical while Next writes its own tree', async t => {
  const fakeAppData = await mkdtemp(join(tmpdir(), 'next-ns-'));
  t.after(() => rm(fakeAppData, { recursive: true, force: true }));

  const legacySentinel = join(legacyUserDataDir(fakeAppData, 'desktop'), 'sentinel.txt');
  await mkdir(join(legacyUserDataDir(fakeAppData, 'desktop')), { recursive: true });
  await writeFile(legacySentinel, 'LEGACY-DATA-UNTouched', 'utf8');

  const nextDir = nextUserDataDir(fakeAppData, 'desktop');
  await mkdir(nextDir, { recursive: true });
  await writeFile(join(nextDir, 'prefs.json'), '{"mode":"full"}', 'utf8');

  assert.equal(await readFile(legacySentinel, 'utf8'), 'LEGACY-DATA-UNTouched', 'legacy sentinel untouched');
  assert.ok(!(await readFile(join(nextDir, 'prefs.json'), 'utf8')).includes('LEGACY'));
});

test('the Electron entry resolves userData through the Next namespace helper', async t => {
  const { fileURLToPath } = await import('node:url');
  const here = fileURLToPath(import.meta.url);
  // here = dist/tests/next/<file>.js: file → next → tests → dist → project root.
  const projectRoot = resolve(here, '..', '..', '..', '..');
  const source = await readFile(resolve(projectRoot, 'desktop', 'electron', 'main.mjs'), 'utf8');
  const setPathLine = source.split('\n').find(line => line.includes("app.setPath('userData'"));
  assert.ok(setPathLine, 'main.mjs must set userData explicitly');
  assert.ok(setPathLine!.includes('nextUserDataDir'), 'userData must go through the namespace helper');
  assert.ok(!setPathLine!.includes('AAAAGENT'), 'the userData line must not hardcode the AAAAGENT root');
});
