import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BackendConnection } from '../desktop/electron/transport.mjs';
import { fitDisplay } from '../desktop/electron/layout.mjs';
import { BackendSession } from '../dist/app/backend-session.js';
import { MemoryMediaStore } from '../dist/media/store.js';
import { SqliteProjectIndex } from '../dist/projects/sqlite-project-index.js';
import { TurnController } from '../dist/core/turn-controller.js';

// Bounded application workloads with synthetic data. No GPU, NPU, microphone,
// account configuration, external task executor, or network provider is used.
const pause = ms => new Promise(done => setTimeout(done, ms));
async function until(predicate, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw Error('Synthetic workload exceeded its deadline');
    await pause(5);
  }
}

test('2,000 Unicode requests survive ten backend sessions without loss or stale delivery', { timeout: 30000 }, async t => {
  let replies = [], errors = [];
  const bridge = new BackendConnection({
    onState: state => { if (state.state === 'failed') errors.push(state.reason); },
    onMessage: message => { if (message.channel === 'event' && message.event.type === 'reply') replies.push(message.event.reply); }
  });
  t.after(() => bridge.close());
  for (let cycle = 0; cycle < 10; cycle++) {
    replies = [];
    const stale = bridge.generation;
    bridge.start(process.execPath, [fileURLToPath(new URL('../dist/app/preview-backend.js', import.meta.url))]);
    await until(() => bridge.state === 'ready');
    assert.equal(bridge.send({ channel: 'command', command: { type: 'submit_text', text: 'stale' } }, stale), false);
    const expected = Array.from({ length: 200 }, (_, i) => `Pseudo task ${cycle}/${i}: 整理项目 🙂 ${'中文 payload '.repeat(i % 20)}`);
    for (const text of expected) assert.equal(bridge.send({ channel: 'command', command: { type: 'submit_text', text } }, bridge.generation), true);
    await until(() => replies.length === expected.length);
    assert.deepEqual(replies.map(reply => reply.text), expected.map(text => 'Offline preview received: ' + text));
    assert.equal(new Set(replies.map(reply => reply.scope.turnId)).size, 200);
    assert.deepEqual(errors, []);
    const exited = once(bridge.child, 'exit');
    bridge.close();
    assert.equal((await exited)[0], 0, 'backend must exit cleanly on EOF');
  }
});

test('250 complete mock conversations release media and preserve every reply', { timeout: 30000 }, async () => {
  const media = new MemoryMediaStore();
  let users = 0, assistants = 0, replies = 0, playbackEnds = 0, closed = false;
  const errors = [], feedback = new Set();
  const session = new BackendSession({
    mediaStore: media,
    perception: { async perceive() { throw Error('Text workload must not use a capture device'); } },
    memory: {
      async append(_scope, messages) { for (const m of messages) m.role === 'user' ? users++ : assistants++; },
      async context(scope) { return { scope, characterPrompt: 'synthetic', recent: [], summary: '', memories: [], perception: null, inputTokenBudget: 1000 }; },
      maintenanceInput(scope) { return { scope, messages: [], relevantMemories: [] }; },
      async maintain() { return []; }
    },
    dialogue: { async reply(input) { return { scope: input.scope, text: 'Synthetic response ' + input.scope.turnId, expression: { emotion: 'neutral', intensity: 0, delivery: '', gesture: null } }; } },
    tts: { async synthesize(input) { return { ...input, audio: await media.put(input.scope, Uint8Array.of(1, 2), 'audio/wav'), durationMs: 10, synchronization: 'amplitude' }; } }
  }, message => {
    if (message.channel === 'event') {
      if (message.event.type === 'reply') replies++;
      if (message.event.type === 'error') errors.push(message.event.message);
      if (message.event.type === 'playback' && message.event.playback.type === 'ended') playbackEnds++;
    }
    if (message.channel === 'play') queueMicrotask(() => {
      const task = (async () => {
        for (const event of [{ type: 'started', audioId: message.tts.audio.id }, { type: 'amplitude', value: .5 }, { type: 'ended' }]) {
          await session.receiveLine(JSON.stringify({ channel: 'playback', requestId: message.requestId,
            event: { ...event, scope: message.tts.scope, at: new Date().toISOString() } }));
        }
      })();
      feedback.add(task); task.then(() => feedback.delete(task), error => { errors.push(error.message); feedback.delete(task); });
    });
  }, () => { closed = true; });
  try {
    for (let i = 0; i < 250; i++) {
      await session.receiveLine(JSON.stringify({ channel: 'command', command: { type: 'submit_text', text: `Synthetic conversation ${i} 中文` } }));
      await session.drain(); await Promise.all(feedback);
      assert.equal(media.count, 0, 'temporary audio must be released after each turn');
    }
    assert.deepEqual(errors, []);
    assert.deepEqual({ users, assistants, replies, playbackEnds }, { users: 250, assistants: 250, replies: 250, playbackEnds: 250 });
  } finally { await session.close(); }
  assert.equal(closed, true);
});

test('300 synthetic projects support updates, conflicts, reopening and deletion', { timeout: 30000 }, async () => {
  const base = resolve(tmpdir());
  const root = await mkdtemp(join(base, 'AAAAGENT-stress-中文-'));
  assert.ok(resolve(root).startsWith(base + sep));
  const filename = join(root, 'synthetic.sqlite');
  let index = new SqliteProjectIndex(filename);
  const entries = [];
  try {
    for (let i = 0; i < 300; i++) entries.push(await index.save({ expectedVersion: 0, name: `Pseudo project ${i}`, abstract: 'Synthetic task, no real project files.', detailRef: { rootPath: root, entryFile: `src/task-${i}.ts` } }));
    for (const entry of entries) {
      const update = { id: entry.id, expectedVersion: entry.version, name: entry.name, abstract: 'Updated 中文', detailRef: entry.detailRef };
      assert.equal((await index.save(update)).version, 2);
      await assert.rejects(index.save(update), error => error.code === 'version_conflict');
    }
    await index.close(); index = new SqliteProjectIndex(filename);
    const all = [];
    for (let offset = 0; offset < 300; offset += 100) {
      const page = await index.list({ offset, limit: 100 });
      assert.equal(page.total, 300); all.push(...page.items);
    }
    assert.equal(new Set(all.map(entry => entry.id)).size, 300);
    assert.ok(all.every(entry => entry.version === 2 && entry.abstract === 'Updated 中文'));
    for (const entry of all) await index.remove(entry.id, entry.version);
    assert.equal((await index.list({})).total, 0);
  } finally {
    await index.close();
    assert.ok(resolve(root).startsWith(base + sep));
    await rm(root, { recursive: true, force: true });
  }
});

test('20,000 rapid replacements reject cancelled and late playback events', () => {
  const turns = new TurnController();
  const at = new Date().toISOString();
  for (let i = 0; i < 20000; i++) {
    const old = turns.begin('text', `Old task ${i}`);
    const current = turns.begin('text', `Current task ${i}`);
    assert.equal(old.signal.aborted, true);
    assert.equal(turns.playback({ scope: old.input.scope, at, type: 'started', audioId: 'stale' }), false);
    assert.equal(turns.playback({ scope: current.input.scope, at, type: 'started', audioId: 'current' }), true);
    assert.equal(turns.playback({ scope: current.input.scope, at, type: 'ended' }), true);
    assert.equal(turns.playback({ scope: current.input.scope, at, type: 'amplitude', value: 1 }), false);
    assert.equal(turns.snapshot().mouth, 0);
  }
});

test('10,000 window transitions remain within varied monitor work areas', () => {
  for (let i = 0; i < 10000; i++) {
    const screen = { x: i % 2 ? -1920 : 0, y: i % 3 ? 0 : -1080, width: 600 + i % 2000, height: 480 + i % 1200 };
    const anchor = { x: screen.x + (i * 7919) % (screen.width * 2), y: screen.y + (i * 37) % (screen.height * 2) };
    const width = 220 + i % 501;
    const closed = fitDisplay(width, false, screen, anchor, i % 2 ? 'half' : 'full');
    const opened = fitDisplay(width, true, screen, closed.anchor, i % 2 ? 'half' : 'full');
    assert.deepEqual(opened.anchor, closed.anchor);
    for (const { bounds } of [closed, opened]) {
      assert.ok(bounds.x >= screen.x && bounds.y >= screen.y);
      assert.ok(bounds.x + bounds.width <= screen.x + screen.width + 1);
      assert.ok(bounds.y + bounds.height <= screen.y + screen.height + 1);
      assert.ok(bounds.width > 0 && bounds.height > 0);
    }
  }
  console.log(`Stress-runner peak RSS: ${Math.round(process.resourceUsage().maxRSS / 1024)} MiB`);
});
