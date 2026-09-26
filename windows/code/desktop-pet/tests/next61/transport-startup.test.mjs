import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackendConnection } from '../../desktop/electron/transport.mjs';

// Real child processes on real pipes; only the wall clock is faked. The fake backend
// answers stdin commands, so the test decides when every protocol record is written.
const BACKEND = [
  "process.stdin.setEncoding('utf8');",
  "let sequence = 0, completed = 0;",
  "const record = () => JSON.stringify({ channel: 'backend_startup', sequence, phase: 'verifying', completed, total: 100, elapsedMs: sequence * 5 });",
  "process.stdin.on('data', chunk => { for (const line of chunk.split('\\n')) {",
  "  if (line === 'progress') { sequence += 1; completed += 5; process.stdout.write(record() + '\\n'); }",
  "  else if (line === 'heartbeat') { process.stdout.write(record() + '\\n'); }",
  "  else if (line === 'ready') { process.stdout.write(JSON.stringify({ channel: 'backend_ready', bridgeVersion: '0.7.0' }) + '\\n'); }",
  "} });",
  "process.stdin.on('end', () => process.exit(0));",
  'setInterval(() => {}, 1000);',
].join('\n');

const lockedBackend = lock => [
  "const fs = require('node:fs');",
  `const lock = ${JSON.stringify(lock)};`,
  "try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx' }); }",
  "catch { process.stdout.write(JSON.stringify({ channel: 'backend_error', reason: 'lock-busy' }) + '\\n'); process.exit(9); }",
  "const clean = () => { try { fs.unlinkSync(lock); } catch {} };",
  "process.stdin.resume();",
  "process.stdin.on('end', () => setTimeout(() => { clean(); process.exit(0); }, 600));",
  "setTimeout(() => process.stdout.write(JSON.stringify({ channel: 'backend_ready' }) + '\\n'), 120);",
  'setInterval(() => {}, 1000);',
].join('\n');

function session(t, options = {}) {
  const messages = [], states = [];
  const transport = new BackendConnection({ onState: value => states.push(value),
    onMessage: (value, generation) => messages.push({ value, generation }), shutdownTimeoutMs: 3000, ...options });
  t.after(() => transport.close());
  return { transport, messages, states };
}
/** Polls on setImmediate: setTimeout is mocked in most cases here and must never drive the wait. */
async function until(predicate, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw Error('Transport timeout');
    await new Promise(resolve => setImmediate(resolve));
  }
  return true;
}
/** Waits for a real protocol record instead of sleeping, so a mocked clock stays the only time source. */
async function exchange(child, line) {
  const received = once(child.stdout, 'data');
  child.stdin.write(line + '\n');
  await received;
}
const progressOf = s => s.states.filter(state => state.phase);
const terminalOf = s => s.states.filter(state => ['failed', 'disconnected'].includes(state.state));

test('03-A: sustained real progress past 60s of accumulated time still reaches ready', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const s = session(t);
  s.transport.start(process.execPath, ['-e', BACKEND]);
  await until(() => !!s.transport.child);
  const child = s.transport.child;
  for (let step = 1; step <= 18; step++) {
    await exchange(child, 'progress');
    assert.equal(progressOf(s).length, step, 'progress record ' + step + ' must reach the shell');
    t.mock.timers.tick(5000);
  }
  assert.equal(s.transport.state, 'connecting', '90s of fake time with real progress must not time out');
  const beforeReady = progressOf(s);
  await exchange(child, 'ready');
  assert.equal(s.transport.state, 'ready');
  const last = beforeReady.at(-1);
  assert.equal(last.sequence, 18); assert.equal(last.completed, 90);
  assert.equal(last.total, 100, 'the reported total is forwarded unchanged');
  assert.equal(last.phase, 'verifying', 'the phase shown while verifying is the backend-reported one');
  assert.equal(progressOf(s).at(-1).phase, 'ready', 'ready ends the startup report');
  assert.deepEqual(terminalOf(s), [], 'no failure state was published');
});

test('03-A: no output terminates on the startup window, repeated heartbeats on the stall window', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const silent = session(t);
  silent.transport.start(process.execPath, ['-e', 'setTimeout(() => {}, 60000)']);
  t.mock.timers.tick(60001);
  assert.equal(silent.transport.state, 'failed');
  assert.equal(silent.states.at(-1).reason, 'ready-timeout');
  assert.equal(silent.states.at(-1).canRetry, true);

  const heartbeats = session(t);
  heartbeats.transport.start(process.execPath, ['-e', BACKEND]);
  await until(() => !!heartbeats.transport.child);
  const child = heartbeats.transport.child;
  for (let step = 1; step <= 20 && heartbeats.transport.state === 'connecting'; step++) {
    await exchange(child, 'heartbeat');
    t.mock.timers.tick(5000);
  }
  assert.equal(heartbeats.transport.state, 'failed', 'identical heartbeats must not renew the window forever');
  assert.equal(heartbeats.states.at(-1).reason, 'stalled');
  assert.equal(heartbeats.states.at(-1).canRetry, true);
  assert.deepEqual(progressOf(heartbeats).filter(state => state.phase !== 'ready'), [],
    'twenty identical heartbeats never publish a single progress update');
});

test('03-A: progress renews a configurable no-progress window and a later stall is visible', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const s = session(t, { timeoutMs: 500, noProgressMs: 2000 });
  s.transport.start(process.execPath, ['-e', BACKEND]);
  await until(() => !!s.transport.child);
  const child = s.transport.child;
  for (let step = 1; step <= 4; step++) {
    await exchange(child, 'progress');
    assert.equal(progressOf(s).length, step);
    t.mock.timers.tick(1500);
  }
  assert.equal(s.transport.state, 'connecting', 'real progress must outlive the initial 500ms window');
  t.mock.timers.tick(2001);
  assert.equal(s.transport.state, 'failed');
  assert.equal(s.states.at(-1).reason, 'stalled');
  assert.equal(terminalOf(s).length, 1, 'a failed generation publishes exactly one terminal state');
});

test('03-B: cancelling startup is diagnosable, ends the child and releases the shutdown bookkeeping', async t => {
  const s = session(t);
  s.transport.start(process.execPath, ['-e', BACKEND]);
  await until(() => !!s.transport.child);
  const child = s.transport.child;
  await exchange(child, 'progress');
  assert.equal(progressOf(s).length, 1);
  assert.equal(typeof s.transport.cancel, 'function', 'the shell needs an explicit startup cancel');
  await s.transport.cancel();
  assert.equal(child.exitCode, 0, 'cancel must let the backend exit on EOF');
  assert.equal(s.states.at(-1).state, 'disconnected');
  assert.equal(s.states.at(-1).reason, 'cancelled');
  assert.equal(s.states.at(-1).canRetry, true);
  assert.equal(s.transport.closing.size, 0);
  assert.equal(s.transport.send({ channel: 'echo' }, s.transport.generation), false);
});

test('03-B: exit before ready and an unlaunchable executable stay visible and retryable', async t => {
  const exited = session(t);
  exited.transport.start(process.execPath, ['-e', 'process.exit(3)']);
  await until(() => ['failed', 'disconnected'].includes(exited.transport.state));
  const last = exited.states.at(-1);
  assert.equal(last.reason, 'exit'); assert.equal(last.canRetry, true);
  assert.equal(last.exitCode, 3);

  const missing = session(t);
  missing.transport.start(process.platform === 'win32' ? 'Z:/missing/node.exe' : '/missing/node', []);
  await until(() => missing.transport.state === 'failed');
  assert.equal(missing.states.at(-1).reason, 'launch');
});

test('03-C: rapid retries keep exactly one live backend and a single released lock', async t => {
  const root = await mkdtemp(join(tmpdir(), 'AAAAGENT-startup-lock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lock = join(root, 'backend.lock');
  const s = session(t);
  s.transport.start(process.execPath, ['-e', lockedBackend(lock)]);
  await until(() => s.transport.state === 'ready');
  const first = s.transport.child, firstGeneration = s.transport.generation;
  assert.equal(existsSync(lock), true);
  const seen = s.states.length;
  const retries = [s.transport.start(process.execPath, ['-e', lockedBackend(lock)]),
    s.transport.start(process.execPath, ['-e', lockedBackend(lock)]),
    s.transport.start(process.execPath, ['-e', lockedBackend(lock)])];
  await Promise.all(retries);
  await until(() => s.transport.state === 'ready');
  assert.equal(s.transport.generation, firstGeneration + 3);
  assert.notEqual(s.transport.child, first);
  assert.notEqual(first.exitCode, null, 'the superseded backend must exit before the replacement spawns');
  assert.equal(existsSync(lock), true, 'exactly one backend holds the lock');
  assert.equal(s.messages.some(message => message.value.channel === 'backend_error'), false, 'no backend ever saw a busy lock');
  assert.equal(s.states.slice(seen).filter(state => state.generation === firstGeneration).length, 0,
    'the superseded generation publishes nothing after its replacement starts');
  assert.equal(s.transport.send({ channel: 'echo' }, firstGeneration), false);
  assert.equal(s.transport.send({ channel: 'echo' }, s.transport.generation), true, 'the live backend still accepts commands');
  await s.transport.close();
  assert.equal(existsSync(lock), false, 'closing the last backend releases the lock file');
});

test('03-C: a superseded generation cannot revive or fail the current one', async t => {
  const root = await mkdtemp(join(tmpdir(), 'AAAAGENT-startup-late-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lock = join(root, 'backend.lock');
  const s = session(t);
  s.transport.start(process.execPath, ['-e', lockedBackend(lock)]);
  await until(() => s.transport.state === 'ready');
  const stale = s.transport.child, staleGeneration = s.transport.generation;
  const seen = s.states.length;
  await s.transport.start(process.execPath, ['-e', lockedBackend(lock)]);
  await until(() => s.transport.state === 'ready');
  assert.notEqual(stale.exitCode, null, 'the previous backend is closed before the replacement spawns');
  const late = s.states.slice(seen);
  assert.equal(late.filter(state => state.generation === staleGeneration).length, 0,
    'late messages from the retired generation never publish a state');
  assert.equal(late.filter(state => state.generation === s.transport.generation).length, 2, 'the new generation publishes connecting then ready');
  assert.equal(s.messages.some(message => message.generation === staleGeneration && message.value.channel !== 'backend_ready'), false);
  assert.deepEqual(s.messages.slice(-1).map(message => message.value.channel), ['backend_ready'],
    'the live generation forwards its own ready exactly once');
});
