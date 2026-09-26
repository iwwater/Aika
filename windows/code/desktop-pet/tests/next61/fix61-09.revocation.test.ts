// FIX61-09 09-C: revocation, compare-and-swap and zero stale delivery (R-TODO-09).
//
// Freezing must never become a leak. A snapshot that was built from content the user has since switched
// away from, corrected, forgotten or protected must stop being usable immediately; the publish of a build
// that raced such a change must be refused; and a restart must not resurrect it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fixture, scope, message, change } from '../memory/sqlite-fixture.js';
import { signal, none, replyMessage } from '../memory/lifecycle-fixture.js';
import { DialoguePipeline, type DialoguePorts } from '../../core/dialogue-pipeline.js';
import { TurnController } from '../../core/turn-controller.js';
import { PrefixSnapshotStore } from '../../memory/prefix-snapshot.js';
import { prefixPort, fakeClock, wire, knowledgeBooks } from './fix61-09.harness.js';

async function settle(): Promise<void> { for (let index = 0; index < 10; index++) await new Promise(resolve => setImmediate(resolve)); }

test('09-C a forget committed while the reply is in flight revokes the prefix, refuses the save and never exposes the reply', { timeout: 30000 }, async t => {
  const f = fixture(); t.after(f.cleanup);
  const store = f.open();
  store.append(scope(), [message('raw', '我喜欢喝红茶')]);
  store.apply(change({ type: 'add', id: 'tea', text: '用户的长期偏好是从红茶开始的', sourceIds: ['raw'] }, 'add-tea'));
  const clock = fakeClock();
  const { port } = prefixPort(store, async input => none(input), { clock });
  const { provider } = wire();
  const one = scope('companion', 'one');
  await port.append(one, [message('one:user', '开场')]);
  const c1 = await port.foregroundContext(one, 'one:user', '开场', null, signal());
  await port.appendAssistant(one, replyMessage(one, '开场回答'), c1, 'one:user', signal());
  await settle();
  const two = scope('companion', 'two');
  await port.append(two, [message('two:user', '猫怎么样')]);
  const c2 = await port.foregroundContext(two, 'two:user', '猫怎么样', null, signal());
  assert.ok(c2.prefix!.text.includes('用户的长期偏好是从红茶开始的'), 'the frozen prefix carries the core memory');

  // The strict forget commits while this very turn is still producing its reply.
  store.apply(change({ type: 'soft_delete', id: 'tea', expectedVersion: 1 }, 'forget-tea'));
  assert.throws(() => port.assertContextCurrent(c2), /stale_context/);
  await assert.rejects(port.appendAssistant(two, replyMessage(two, '回答'), c2, 'two:user', signal()), /stale_context/);

  // The real pipeline, on the same revoked context: the reply is never exposed, saved or spoken.
  const events: string[] = [];
  const controller = new TurnController();
  const turn = controller.begin('text', '猫怎么样');
  const ports: DialoguePorts = {
    perception: { async perceive() { throw new Error('text must not capture'); } },
    memory: { async context() { throw new Error('unused'); }, async append() {}, async maintain() { return []; } },
    backgroundMemory: {
      async foregroundContext() { return c2; },
      assertContextCurrent(context) { port.assertContextCurrent(context); },
      async enqueueTurn() { throw new Error('unused'); },
      async appendForegroundAssistant() { throw new Error('unused'); },
    },
    dialogue: { async reply(input) { events.push('reply'); return { scope: input.scope, text: '红茶很好。', expression: { emotion: 'calm', intensity: 0.2, delivery: '自然', gesture: null } }; } },
    tts: { async synthesize() { events.push('tts'); throw new Error('tts must not run'); } },
    playback: { async play() { events.push('play'); }, async stop() {} },
    mediaStore: { async put() { throw new Error('unused'); }, async read() { throw new Error('unused'); }, async releaseScope() {} },
  };
  const outcome = await new DialoguePipeline(ports, controller, event => events.push(event.type)).run(turn.input, turn.signal);
  assert.equal(outcome.status, 'failed', 'a revoked context cannot produce a delivered reply');
  assert.equal(events.includes('reply'), false, 'the revoked reply is never exposed to the UI');
  assert.equal(events.includes('tts'), false, 'and never synthesized');
  assert.equal(store.inspect(two, 'two:assistant'), null, 'and never written back as an assistant turn');

  // The next turn runs on the safe minimal prefix and does not carry the forgotten text.
  const three = scope('companion', 'three');
  await port.append(three, [message('three:user', '再说一句')]);
  const c3 = await port.foregroundContext(three, 'three:user', '再说一句', null, signal());
  assert.ok(!c3.prefix!.text.includes('用户的长期偏好是从红茶开始的'), 'the revoked memory never reaches the next turn');
  await settle();
  const four = scope('companion', 'four');
  await port.append(four, [message('four:user', '问一句')]);
  const c4 = await port.foregroundContext(four, 'four:user', '问一句', null, signal());
  assert.equal(c4.prefix!.complete, true, 'the rebuilt snapshot is a full one');
  assert.ok(!c4.prefix!.text.includes('用户的长期偏好是从红茶开始的'), 'the forgotten memory stays out of the rebuilt snapshot');
  const call = await provider.reply({ scope: four, text: '问一句', context: c4 }, signal()).then(() => 'ok');
  assert.equal(call, 'ok');
});

test('09-C a prompt edit revokes the identity inside a frozen prefix before the next request', { timeout: 30000 }, async t => {
  const f = fixture(); t.after(f.cleanup);
  const store = f.open();
  store.append(scope(), [message('raw', '用户喜欢红茶')]);
  store.apply(change({ type: 'add', id: 'tea', text: '用户喜欢红茶', sourceIds: ['raw'] }, 'add-tea'));
  const clock = fakeClock();
  const { port } = prefixPort(store, async input => none(input), { clock });
  const { calls, provider } = wire();
  const one = scope('companion', 'one');
  await port.append(one, [message('one:user', '开场')]);
  const c1 = await port.foregroundContext(one, 'one:user', '开场', null, signal());
  await port.appendAssistant(one, replyMessage(one, '开场回答'), c1, 'one:user', signal());
  await settle();
  const two = scope('companion', 'two');
  await port.append(two, [message('two:user', '第二句')]);
  const c2 = await port.foregroundContext(two, 'two:user', '第二句', null, signal());
  assert.ok(c2.prefix!.text.includes('青梅竹马'), 'the frozen prefix carries the compiled identity');

  store.editPrompt(scope(), { expectedRevision: store.promptSnapshot(scope()).revision, text: '全新的身份设定：你是用户的同事。', operationId: 'prompt-edit' });
  assert.throws(() => port.assertContextCurrent(c2), /stale_context/);

  const three = scope('companion', 'three');
  await port.append(three, [message('three:user', '第三句')]);
  const c3 = await port.foregroundContext(three, 'three:user', '第三句', null, signal());
  assert.ok(!c3.prefix!.text.includes('青梅竹马'), 'the stale identity is gone');
  assert.ok(c3.prefix!.text.includes('你是用户的同事'), 'the next turn uses the edited identity');
  await settle();
  const four = scope('companion', 'four');
  await port.append(four, [message('four:user', '第四句')]);
  const c4 = await port.foregroundContext(four, 'four:user', '第四句', null, signal());
  await provider.reply({ scope: four, text: '第四句', context: c4 }, signal());
  const delivered = JSON.stringify(calls.at(-1)!.messages);
  assert.ok(delivered.includes('你是用户的同事'), 'the edited identity is what reaches the provider');
  assert.ok(!delivered.includes('青梅竹马'), 'the superseded identity never reaches the provider');
});

test('09-C switching or removing the knowledge library revokes the frozen prefix', { timeout: 30000 }, async t => {
  const f = fixture(); t.after(f.cleanup);
  const store = f.open();
  store.append(scope(), [message('raw', '用户喜欢红茶')]);
  store.apply(change({ type: 'add', id: 'tea', text: '用户喜欢红茶', sourceIds: ['raw'] }, 'add-tea'));
  const clock = fakeClock();
  const books = knowledgeBooks({ libraryId: 'kb-one', blocks: [{ documentId: 'kd-1', ordinal: 0, text: '第一本手册的内容。' }] });
  const { port } = prefixPort(store, async input => none(input), { clock, books: () => books.read(), knowledgeRevision: () => books.revision });
  const { calls, provider } = wire();
  const one = scope('companion', 'one');
  await port.append(one, [message('one:user', '开场')]);
  const c1 = await port.foregroundContext(one, 'one:user', '开场', null, signal());
  await port.appendAssistant(one, replyMessage(one, '开场回答'), c1, 'one:user', signal());
  await settle();
  const two = scope('companion', 'two');
  await port.append(two, [message('two:user', '手册说什么')]);
  const c2 = await port.foregroundContext(two, 'two:user', '手册说什么', null, signal());
  assert.ok(c2.prefix!.text.includes('第一本手册的内容。'), 'the frozen prefix carries the selected library block');

  books.switchTo({ libraryId: 'kb-two', blocks: [{ documentId: 'kd-2', ordinal: 0, text: '第二本手册的内容。' }] });
  assert.throws(() => port.assertContextCurrent(c2), /stale_context/);

  const three = scope('companion', 'three');
  await port.append(three, [message('three:user', '再看一眼')]);
  const c3 = await port.foregroundContext(three, 'three:user', '再看一眼', null, signal());
  assert.ok(!c3.prefix!.text.includes('第一本手册的内容。'), 'the switched-away library stays out');
  await settle();
  const four = scope('companion', 'four');
  await port.append(four, [message('four:user', '现在呢')]);
  const c4 = await port.foregroundContext(four, 'four:user', '现在呢', null, signal());
  assert.ok(c4.prefix!.text.includes('第二本手册的内容。'), 'the newly active library is frozen instead');
  assert.ok(!c4.prefix!.text.includes('第一本手册的内容。'));
  await provider.reply({ scope: four, text: '现在呢', context: c4 }, signal());
  const delivered = JSON.stringify(calls.at(-1)!.messages);
  assert.ok(delivered.includes('第二本手册的内容。'));
  assert.ok(!delivered.includes('第一本手册的内容。'), 'the old library text never reaches the provider after the switch');

  // Removing the active document is a knowledge revocation too, not an ordinary edit.
  books.removeDocument('kd-2');
  assert.throws(() => port.assertContextCurrent(c4), /stale_context/);
});

test('09-C a build that raced a switch is refused by CAS and never replaces the newer snapshot', { timeout: 30000 }, async t => {
  const f = fixture(); t.after(f.cleanup);
  const store = f.open();
  const clock = fakeClock();
  const snapshots = new PrefixSnapshotStore(store.rawDatabaseForKnowledge(), { clock: () => clock.now() });
  const boundary: import('../../contracts/index.js').TurnScope = { characterId: 'companion', sessionId: 'session-cas', turnId: 'cas', generation: 1 };
  const key = (overrides: Partial<import('../../memory/prefix-snapshot.js').PrefixKey> = {}) => ({
    characterId: 'companion', sessionId: 'session-cas', identityHash: 'h', policyRevision: 1, privacyRevision: snapshots.privacyRevision(store, 'companion'),
    protocol: 'openai-compatible', model: 'm', tokenBudget: 100, knowledge: null, knowledgeFingerprint: 'k', maxMemories: 6, summaryLimit: 4, ...overrides,
  });
  const live = () => ({ key: key(), privacyRevision: snapshots.privacyRevision(store, 'companion') });
  const hashOf = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
  const candidate = { text: 'FIRST', hash: hashOf('FIRST'), summary: '', memories: [], messages: [], sources: [], watermark: 0 };

  // A configuration change while the build was running: the publish is refused with a typed diagnostic.
  const first = snapshots.beginBuild(boundary, live().key, live().privacyRevision);
  assert.throws(
    () => snapshots.publish({ snapshot: first, candidate, currentKey: key({ model: 'changed-while-building' }), currentPrivacyRevision: live().privacyRevision }),
    /prefix_snapshot_superseded/
  );
  assert.equal(snapshots.load(boundary)!.status, 'building', 'a refused publish leaves the row unpublished');
  assert.equal(snapshots.reusable(store, boundary, live()), null, 'and nothing becomes reusable');

  // A privacy change during the build is refused the same way, with the same diagnostic.
  const second = snapshots.beginBuild(boundary, live().key, live().privacyRevision);
  assert.throws(
    () => snapshots.publish({ snapshot: second, candidate, currentKey: live().key, currentPrivacyRevision: live().privacyRevision + 1 }),
    /prefix_snapshot_superseded/
  );
  // A knowledge-revision change is part of the same key comparison, not a second counter.
  const third = snapshots.beginBuild(boundary, live().key, live().privacyRevision);
  assert.throws(
    () => snapshots.publish({ snapshot: third, candidate, currentKey: key({ knowledge: { libraryId: 'kb', libraryRevision: 1, revision: 9 } }), currentPrivacyRevision: live().privacyRevision }),
    /prefix_snapshot_superseded/
  );

  // A well-formed publish for the current key succeeds, and is then validated against that key.
  const fourth = snapshots.beginBuild(boundary, live().key, live().privacyRevision);
  const published = snapshots.publish({ snapshot: fourth, candidate, currentKey: live().key, currentPrivacyRevision: live().privacyRevision });
  assert.equal(published.prefixText, 'FIRST');
  assert.equal(snapshots.reusable(store, boundary, live())!.id, fourth.id);
  assert.equal(snapshots.reusable(store, boundary, { ...live(), privacyRevision: live().privacyRevision + 1 }), null, 'a later privacy change stops the snapshot from being reusable');
  assert.equal(snapshots.reusable(store, boundary, { key: key({ model: 'other-model' }), privacyRevision: live().privacyRevision }), null, 'a later configuration change stops it too');

  // A torn write is never restored: the stored bytes and the stored hash must agree.
  store.rawDatabaseForKnowledge().prepare('UPDATE memory_prefix_snapshots SET prefix_text=? WHERE id=?').run('TAMPERED', fourth.id);
  assert.equal(snapshots.reusable(store, boundary, live()), null, 'a bad stored hash is not restored as usable');
});

test('09-C a revoked snapshot is not resurrected by a restart', { timeout: 30000 }, async t => {
  const f = fixture(); t.after(f.cleanup);
  let store = f.open();
  store.append(scope(), [message('raw', '我喜欢喝红茶')]);
  store.apply(change({ type: 'add', id: 'tea', text: '用户的长期偏好是从红茶开始的', sourceIds: ['raw'] }, 'add-tea'));
  const clock = fakeClock();
  const { port } = prefixPort(store, async input => none(input), { clock });
  const { calls, provider } = wire();
  const one = scope('companion', 'one');
  await port.append(one, [message('one:user', '开场')]);
  const c1 = await port.foregroundContext(one, 'one:user', '开场', null, signal());
  await port.appendAssistant(one, replyMessage(one, '开场回答'), c1, 'one:user', signal());
  await settle();
  const two = scope('companion', 'two');
  await port.append(two, [message('two:user', '第二句')]);
  const c2 = await port.foregroundContext(two, 'two:user', '第二句', null, signal());
  assert.ok(c2.prefix!.text.includes('用户的长期偏好是从红茶开始的'));
  await port.appendAssistant(two, replyMessage(two, '第二句回答'), c2, 'two:user', signal());
  await settle();

  // The stored snapshot really did pin the memory that is about to be forgotten.
  const stored = store.rawDatabaseForKnowledge().prepare('SELECT sources_json FROM memory_prefix_snapshots WHERE status=?').all('active') as { sources_json: string }[];
  assert.ok(stored.some(row => row.sources_json.includes('tea')), 'the persisted snapshot pinned the memory version');

  store.apply(change({ type: 'soft_delete', id: 'tea', expectedVersion: 1 }, 'forget-tea'));
  store.close();
  store = f.open();
  const restarted = prefixPort(store, async input => none(input), { clock });
  const three = scope('companion', 'three');
  await restarted.port.append(three, [message('three:user', '重启后')]);
  const c3 = await restarted.port.foregroundContext(three, 'three:user', '重启后', null, signal());
  assert.ok(!c3.prefix!.text.includes('用户的长期偏好是从红茶开始的'), 'restart validation rejects the revoked snapshot');
  assert.equal(c3.prefix!.complete, false, 'the revoked snapshot is replaced by the safe minimal prefix, not restored');
  await provider.reply({ scope: three, text: '重启后', context: c3 }, signal());
  assert.ok(!JSON.stringify(calls.at(-1)!.messages).includes('用户的长期偏好是从红茶开始的'), 'and the forgotten text is not delivered after the restart');
});
