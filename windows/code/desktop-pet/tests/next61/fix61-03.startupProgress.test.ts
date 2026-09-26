import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, cp, symlink, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fixture } from '../management/helpers.js';

// FIX61-03: the backend publishes typed backend_startup progress on stdout before backend_ready.
// This is the production composition root, so only the wall clock and providers are synthetic.

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

test('trial backend publishes typed backend_startup progress on real stdout before ready', async t => {
  const f = await fixture(t);
  const source = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const project = join(f.c.projectRoot, 'code/desktop-pet');
  await mkdir(project, { recursive: true });
  await cp(join(source, 'dist'), join(project, 'dist'), { recursive: true });
  await cp(join(source, 'management/ui'), join(project, 'management/ui'), { recursive: true });
  await cp(join(source, 'desktop/assets/local-model'), join(project, 'desktop/assets/local-model'), { recursive: true });
  // The management server scans the Cubism shader directory for its presentation asset routes.
  await cp(join(source, 'desktop/vendor/cubism'), join(project, 'desktop/vendor/cubism'), { recursive: true });
  // A directory junction works without Windows symlink privileges and resolves for module loading.
  await symlink(join(source, 'node_modules'), join(project, 'node_modules'), 'junction');
  await writeFile(join(project, 'package.json'), '{"type":"module"}');
  // The unlimited user-trial configuration skips per-call review bounds and per-call cost gates.
  // The Electron host replaces the default macOS bundle in this fixture's runtime file set.
  const unlimited = { ...f.c, desktopHost: 'electron' as const, budgetMode: 'unlimited' as const, limitMicros: null as null,
    operationLimits: { admission: 0, dialogue: 0, memory_turn: 0, summary: 0, perception: 0, tts: 0 }, maxCalls: 0 };
  for (const key of Object.keys(unlimited.models) as (keyof typeof unlimited.models)[])
    (unlimited.models as Record<string, { reservationMicros: number }>)[key]!.reservationMicros = 1;
  const runtimeFiles: Record<string, string> = {};
  for (const path of ['dist/app/trial-backend.js', 'dist/app/trial-launcher.js', 'desktop/build/renderer.js',
    'desktop/electron/main.mjs', 'desktop/electron/preload.cjs', 'desktop/electron/transport.mjs',
    'desktop/electron/layout.mjs', 'desktop/electron/assets.mjs', 'tools/management-url.mjs']) {
    const key = 'code/desktop-pet/' + path, destination = join(unlimited.projectRoot, key);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(source, path), destination);
    runtimeFiles[key] = hash(await readFile(destination));
  }
  const config = { ...unlimited, runtimeFiles }, raw = JSON.stringify(config);
  await writeFile(f.configFile, raw);
  await writeFile(f.activationFile, JSON.stringify({ version: 1, status: 'active', phaseId: config.phaseId, configSha256: hash(raw) }));
  const child = spawn(process.execPath, [join(project, 'dist/app/trial-backend.js')],
    { env: { ...process.env, PET_TRIAL_CONFIG: f.configFile, PET_TRIAL_ACTIVATION: f.activationFile }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(async () => { if (child.exitCode === null) { child.stdin.end(); await new Promise(done => child.once('exit', done)); } });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += String(chunk); });
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  const exited = new Promise<number | null>(done => child.once('exit', done));
  const deadline = Date.now() + 20000;
  while (!stdout.includes('"channel":"backend_ready"')) {
    if (child.exitCode !== null) throw new Error('backend exited ' + child.exitCode + ': ' + stderr);
    if (Date.now() > deadline) throw new Error('backend never became ready; stdout so far: ' + stdout);
    await new Promise(done => setTimeout(done, 20));
  }
  const messages = stdout.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return undefined; } })
    .filter(Boolean) as { channel: string; phase?: string; sequence?: number; completed?: number; total?: number; code?: string }[];
  const startup = messages.filter(m => m.channel === 'backend_startup');
  assert.ok(startup.length >= 2, 'the backend must report at least verifying and initializing, got: ' + JSON.stringify(messages.map(m => m.channel)));
  assert.equal(startup[0]!.phase, 'verifying');
  assert.equal(startup[0]!.sequence, 1, 'the readiness probe starts at sequence 1');
  for (const [index, record] of startup.entries()) {
    assert.ok(Number.isSafeInteger(record.sequence) && (record.sequence as number) > 0);
    assert.ok(Number.isSafeInteger(record.completed) && (record.completed as number) >= (record.sequence as number));
    assert.ok(['verifying', 'initializing'].includes(record.phase as string), 'phases stay within the frozen set, got ' + record.phase);
    if (index > 0) {
      assert.ok((record.sequence as number) > (startup[index - 1]!.sequence as number), 'the sequence strictly advances');
      assert.ok((record.completed as number) >= (startup[index - 1]!.completed as number), 'completed never moves backwards');
    }
  }
  assert.ok(startup.every(record => !('path' in record) && !('credential' in record)),
    'startup records carry no filesystem paths or credential material');
  assert.equal(messages.find(m => m.channel === 'backend_ready')?.channel, 'backend_ready');
  // Ending stdin must still reach the clean shutdown path that removes the backend lock.
  child.stdin.end();
  assert.equal(await exited, 0, 'clean EOF shutdown still works: ' + stderr);
  const lockPath = join(f.c.projectRoot, '.local/model-evaluation/backend.lock');
  await assert.rejects(readFile(lockPath), /ENOENT/, 'the lock file must be released on shutdown');
});
