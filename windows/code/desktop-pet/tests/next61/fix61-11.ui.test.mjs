import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { startConsoleFixture } from './fix61-11.ui-fixture.mjs';

// FIX61-11 11-E: a real Windows Chromium window loads the REAL console shell and the REAL skin/health view
// modules. Only the network transport is replaced, so the pages under test are production code and the
// scenario proves the two features are reachable from the sidebar rather than merely existing on disk.
test('Windows Chromium: 外观/换肤 and 模块状态 are reachable and render their real routes', { timeout: 120_000 }, async t => {
  const fixture = await startConsoleFixture('./fix61-11.ui-scenario.mjs');
  t.after(() => fixture.close());
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(createRequire(import.meta.url)('electron'), [
    fileURLToPath(new URL('./fix61-11.ui-electron.mjs', import.meta.url)), fixture.url,
  ], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let output = '';
  child.stdout.on('data', bytes => { output += bytes; });
  child.stderr.on('data', bytes => t.diagnostic(bytes.toString()));
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(Error('Electron exited ' + code)));
  });
  const prefix = 'CONSOLE_UI_RESULT=';
  const line = output.split(/\r?\n/).find(value => value.startsWith(prefix));
  assert.ok(line, 'Electron must return its console UI scenario results');
  const result = JSON.parse(line.slice(prefix.length));
  const debug = output.split(/\r?\n/).find(value => value.startsWith('CONSOLE_UI_DEBUG='));
  if (debug) t.diagnostic(debug.slice(0, 600));
  assert.equal(result.error, undefined, 'the scenario must complete: ' + JSON.stringify(result.checks));
  assert.equal(result.failed, 0, 'scenario failures: ' + JSON.stringify(result.checks.filter(c => !c.ok)));
  assert.equal(result.passed, 25, 'expected 25 checks, got: ' + JSON.stringify(result.checks));
});
