// FIX61-02 02-C: a real DOM test of the production console page. It drives the real aika.html markup and
// the real management/ui/aika-view.mjs module against a fake management transport; nothing about the page
// logic under test is stubbed. Windows Chromium via Electron, as with the existing emotion UI test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { startAikaUiFixture } from './fix61-02.ui-fixture.mjs';

test('Windows Chromium: Aika model form fetches, filters, saves through /api/settings and leaks no key', { timeout: 60_000 }, async t => {
  const fixture = await startAikaUiFixture();
  t.after(() => fixture.close());
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(createRequire(import.meta.url)('electron'), [
    fileURLToPath(new URL('./fix61-02.ui-electron.mjs', import.meta.url)), fixture.url,
  ], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let output = '';
  child.stdout.on('data', bytes => { output += bytes; });
  child.stderr.on('data', bytes => t.diagnostic(bytes.toString()));
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(Error('Electron exited ' + code)));
  });
  const prefix = 'AIKA_UI_RESULT=';
  const line = output.split(/\r?\n/).find(value => value.startsWith(prefix));
  assert.ok(line, 'Electron must return its UI scenario results');
  const result = JSON.parse(line.slice(prefix.length));
  const debug = output.split(/\r?\n/).find(value => value.startsWith('AIKA_UI_DEBUG='));
  // Only surface the page dump when the scenario did not finish cleanly.
  if (debug) t.diagnostic(debug.slice(0, 400));
  assert.equal(result.error, undefined, 'the scenario must complete without an error: ' + JSON.stringify(result.failures));
  assert.equal(result.passed, 6, 'scenario failures: ' + JSON.stringify(result.failures));
  assert.deepEqual(result.errors, []);
});
