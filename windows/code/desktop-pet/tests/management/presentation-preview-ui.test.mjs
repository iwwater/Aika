import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { startPresentationPreviewFixture } from './presentation-preview-fixture.mjs';

test('Windows Electron: independent preview loads installed Cubism model, textures and shaders then disposes', { timeout: 60_000 }, async t => {
  const fixture = await startPresentationPreviewFixture();
  t.after(() => fixture.close());
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(createRequire(import.meta.url)('electron'), [
    fileURLToPath(new URL('./presentation-preview-electron.mjs', import.meta.url)), fixture.url,
  ], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let output = '';
  child.stdout.on('data', bytes => { output += bytes; });
  child.stderr.on('data', bytes => t.diagnostic(bytes.toString()));
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(Error('Electron preview scenario timed out')); }, 55_000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); code === 0 ? resolve() : reject(Error('Electron exited ' + code)); });
  });
  const prefix = 'PRESENTATION_PREVIEW_RESULT=';
  const line = output.split(/\r?\n/).find(value => value.startsWith(prefix));
  assert.ok(line, 'Electron must return the preview scenario result');
  const result = JSON.parse(line.slice(prefix.length));
  assert.equal(result.error, undefined);
  assert.equal(result.passed, 1);
  assert.ok(result.resources.some(path => path.endsWith('.moc3')));
  assert.ok(result.resources.some(path => path.endsWith('.png')));
});
