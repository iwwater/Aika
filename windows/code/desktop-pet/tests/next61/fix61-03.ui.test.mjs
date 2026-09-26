import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// FIX61-03 03-D: a real Windows Chromium window loads the production desktop page (index.html plus
// the bundled build/renderer.js) from a local server. Only the native shell bridge is replaced, so
// the page logic under test — startup progress rendering, cancel and retry entries — is not stubbed.
const root = new URL('../../desktop/', import.meta.url);
const FILES = { '/style.css': 'style.css', '/build/renderer.js': 'build/renderer.js',
  '/vendor/cubism/Core/live2dcubismcore.min.js': 'vendor/cubism/Core/live2dcubismcore.min.js' };

async function startFixture() {
  const index = (await readFile(new URL('index.html', root), 'utf8'))
    .replace('<script type="module" src="build/renderer.js"></script>',
      '<script type="module" src="/scenario.mjs"></script><script type="module" src="/build/renderer.js"></script>');
  if (!index.includes('/scenario.mjs')) throw new Error('index.html no longer loads its renderer the expected way');
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    if (path === '/' || path === '/index.html') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(index); return; }
    const file = path === '/scenario.mjs' ? new URL('./fix61-03.ui-scenario.mjs', import.meta.url)
      : FILES[path] ? new URL(FILES[path], root) : null;
    if (!file || req.method !== 'GET') { res.writeHead(404); res.end(); return; }
    try { res.setHeader('Content-Type', path.endsWith('.css') ? 'text/css' : 'text/javascript'); res.end(await readFile(file)); }
    catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: 'http://127.0.0.1:' + server.address().port + '/', close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}

test('Windows Chromium: startup phases, cancel and retry are visible and restore text and voice entries', { timeout: 90_000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(createRequire(import.meta.url)('electron'), [
    fileURLToPath(new URL('./fix61-03.ui-electron.mjs', import.meta.url)), fixture.url,
  ], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let output = '';
  child.stdout.on('data', bytes => { output += bytes; });
  child.stderr.on('data', bytes => t.diagnostic(bytes.toString()));
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(Error('Electron exited ' + code)));
  });
  const prefix = 'STARTUP_UI_RESULT=';
  const line = output.split(/\r?\n/).find(value => value.startsWith(prefix));
  assert.ok(line, 'Electron must return its UI scenario results');
  const result = JSON.parse(line.slice(prefix.length));
  const debug = output.split(/\r?\n/).find(value => value.startsWith('STARTUP_UI_DEBUG='));
  if (debug) t.diagnostic(debug.slice(0, 400));
  assert.equal(result.error, undefined, 'the scenario must complete: ' + JSON.stringify(result.checks));
  assert.equal(result.failed, 0, 'scenario failures: ' + JSON.stringify(result.checks.filter(c => !c.ok)));
  assert.equal(result.passed, 13, 'expected 13 checks, got: ' + JSON.stringify(result.checks));
});
