// FIX61-09 09-D: recovery, degraded paths and the no-full-library-scan guarantee (R-TODO-09).
//
// A snapshot store has to survive its own failures: an interrupted build, a tampered row, a version
// conflict, and a first turn that simply has no snapshot yet. In every one of those cases the turn must
// still be served on a safe bounded prefix, and an ordinary turn must never re-run whole-library
// retrieval just to prove that its frozen prefix is still allowed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, scope, message, change } from '../memory/sqlite-fixture.js';
import { signal, none, replyMessage } from '../memory/lifecycle-fixture.js';
import { PrefixSnapshotStore } from '../../memory/prefix-snapshot.js';
import { SqliteMemoryStore } from '../../memory/sqlite-store.js';
import { prefixPort, fakeClock, wire, countingStore, knowledgeBooks } from './fix61-09.harness.js';

async function settle(): Promise<void> { for (let index = 0; index < 10; index++) await new Promise(resolve => setImmediate(resolve)); }

test('09-D a first turn with no snapshot is served immediately on the safe minimal prefix', { timeout: 30000 }, async t => {
  const f = fixture(); t.after(f.cleanup);
  const store = f.open();
  store.append(scope(), [message('raw', '用户喜欢红茶')]);
  store.apply(change({ type: 'add', id: 'tea', text: '用户喜欢红茶', sourceIds: ['raw'] }, 'add-tea'));
  const clock = fakeClock();
  const { port } = prefixPort(store, async input => none(input), { clock });
  const { calls, provider } = wire();
  const one = scope('companion', 'one');
  await port.append(one, [message('one:user', '第一句')]);
  // The build is scheduled but deliberately not awaited: this is the very first turn of a fresh store.
  const context = await port.foregroundContext(one, 'one:user', '第一句', null, signal());
  assert.equal(context.prefix!.id, 'prefix:minimal', 'the first turn pins the safe minimal prefix');
  assert.equal(context.prefix!.complete, false, 'and reports that it is not a full snapshot');
  assert.ok(context.prefix!.text.includes('青梅竹马'), 'it still carries the current identity');
  assert.ok(!context.prefix!.text.includes('用户喜欢红茶'), 'and no unvalidated library content');
  assert.equal(context.prefix!.messages.length, 0);
  await provider.reply({ scope: one, text: '第一句', context }, signal());
  assert.equal(calls.length, 1, 'the turn reaches the provider without waiting for any build');
  assert.equal((calls[0]!.messages[0]!.content), context.prefix!.text, 'the minimal prefix is what the provider received first');
  assert.ok(calls[0]!.body.prefixId === 'prefix:minimal');
  assert.equal(typeof calls[0]!.body.suffixBytes, 'number', 'the request carries its own dynamic-suffix budget');
});

test('09-D an interrupted or abandoned build is recoverable and never leaves a half-written snapshot', { timeout: 30000 }, async t => {
  const f = fixture(); t.after(f.cleanup);
  const store = f.open();
  const clock = fakeClock();
  const snapshots = new PrefixSnapshotStore(store.rawDatabaseForKnowledge(), { clock: () => clock.now() });
  const boundary = scope('companion', 'recover');
  const key = { characterId: 'companion', sessionId: 'session-1', identityHash: 'h', policyRevision: 1, privacyRevision: 0, protocol: 'p', model: 'm', tokenBudget: 10, knowledge: null, knowledgeFingerprint: 'k', maxMemories: 6, summaryLimit: 4 };
  // A build that started and then the process died: the row stays 'building' and is not reusable.
  const abandoned = snapshots.beginBuild(boundary, key, 0);
  assert.equal(snapshots.load(boundary)!.status, 'building');
  assert.equal(snapshots.reusable(store, boundary, { key, privacyRevision: 0 }), null, 'an unfinished build is never handed out');
  // The next attempt supersedes it rather than trying to finish somebody else's half-written row.
  const retried = snapshots.beginBuild(boundary, key, 0);
  assert.equal(snapshots.load(boundary)!.status, 'building');
  assert.equal(retried.revision, abandoned.revision + 1);
  assert.throws(
    () => snapshots.publish({ snapshot: abandoned, candidate: { text: 'X', hash: '', summary: '', memories: [], messages: [], sources: [], watermark: 0 }, currentKey: key, currentPrivacyRevision: 0 }),
    /prefix_snapshot_superseded/,
    'the superseded build cannot publish after the fact'
  );
  snapshots.fail(retried);
  assert.equal(snapshots.load(boundary)!.status, 'failed');
  assert.equal(snapshots.reusable(store, boundary, { key, privacyRevision: 0 }), null);
});

test('09-D a tampered snapshot row is discarded on load, not restored', { timeout: 30000 }, async t => {
  const f = fixture(); t.after(f.cleanup);
  const store = f.open();
  store.append(scope(), [message('raw', '用户喜欢红茶')]);
  store.apply(change({ type: 'add', id: 'tea', text: '用户喜欢红茶', sourceIds: ['raw'] }, 'add-tea'));
  const clock = fakeClock();
  const { port, snapshots } = prefixPort(store, async input => none(input), { clock });
  const one = scope('companion', 'one');
  await port.append(one, [message('one:user', '开场')]);
  const c1 = await port.foregroundContext(one, 'one:user', '开场', null, signal());
  await port.appendAssistant(one, replyMessage(one, '开场回答'), c1, 'one:user', signal());
  await settle();
  const active = snapshots.load(one)!;
  assert.equal(active.status, 'active');
  assert.ok(active.record.hash);
  // A torn write or external corruption: the bytes and the stored hash no longer agree.
  store.rawDatabaseForKnowledge().prepare('UPDATE memory_prefix_snapshots SET prefix_text=? WHERE id=?').run('CORRUPTED-PREFIX', active.record.id);
  assert.equal(snapshots.load(one), null, 'a bad hash is discarded at load time');
  const two = scope('companion', 'two');
  await port.append(two, [message('two:user', '第二句')]);
  const c2 = await port.foregroundContext(two, 'two:user', '第二句', null, signal());
  assert.ok(!JSON.stringify(c2).includes('CORRUPTED-PREFIX'), 'corrupted bytes are never delivered');
  assert.equal(c2.prefix!.complete, false, 'and the turn falls back to the safe minimal prefix');
});

test('09-D a snapshot whose key version conflicts is refused, and the turn still runs', { timeout: 30000 }, async t => {
  const f = fixture(); t.after(f.cleanup);
  let store = f.open();
  store.append(scope(), [message('raw', '用户喜欢红茶')]);
  store.apply(change({ type: 'add', id: 'tea', text: '用户喜欢红茶', sourceIds: ['raw'] }, 'add-tea'));
  const clock = fakeClock();
  const { port, snapshots } = prefixPort(store, async input => none(input), { clock });
  const one = scope('companion', 'one');
  await port.append(one, [message('one:user', '开场')]);
  const c1 = await port.foregroundContext(one, 'one:user', '开场', null, signal());
  await port.appendAssistant(one, replyMessage(one, '开场回答'), c1, 'one:user', signal());
  await settle();
  const conflicting = snapshots.load(one)!.record;
  // The stored key names a protocol/model binding that no longer matches this build.
  store.rawDatabaseForKnowledge().prepare("UPDATE memory_prefix_snapshots SET key_json=replace(key_json,'\"model\":\"fixture-model\"','\"model\":\"other-model\"')").run();
  const two = scope('companion', 'two');
  await port.append(two, [message('two:user', '第二句')]);
  const c2 = await port.foregroundContext(two, 'two:user', '第二句', null, signal());
  assert.equal(c2.prefix!.complete, false, 'a key conflict downgrades to the safe minimal prefix');
  assert.notEqual(c2.prefix!.id, conflicting.id, 'the conflicting row is not the one served');
  assert.ok(c2.prefix!.text.includes('青梅竹马'));
  store.close(); store = f.open();
  const restarted = prefixPort(store, async input => none(input), { clock });
  const three = scope('companion', 'three');
  await restarted.port.append(three, [message('three:user', '第三句')]);
  const c3 = await restarted.port.foregroundContext(three, 'three:user', '第三句', null, signal());
  assert.notEqual(c3.prefix!.id, conflicting.id, 'the conflicting key is never restored, only replaced by a valid snapshot');
  assert.ok(c3.prefix!.text.includes('青梅竹马'), 'and the turn is still served');
});

test('09-D an ordinary foreground turn performs no whole-library retrieval', { timeout: 30000 }, async t => {
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
  const counts = countingStore(store);
  for (const turn of ['two', 'three', 'four', 'five', 'six']) {
    const owned = scope('companion', turn);
    await port.append(owned, [message(turn + ':user', turn + ' 的问题')]);
    const context = await port.foregroundContext(owned, turn + ':user', turn + ' 的问题', null, signal());
    await provider.reply({ scope: owned, text: turn + ' 的问题', context }, signal());
    await port.appendAssistant(owned, replyMessage(owned, turn + ' 的回答'), context, turn + ':user', signal());
    await settle();
  }
  assert.ok(calls.length >= 5);
  assert.equal(counts.rank, 0, 'a frozen turn never re-ranks the whole memory library');
  // The only bounded reads are the lightweight validation window and the build input.
  assert.ok(counts.contextRecords <= 3 * 5, 'reuse is proven by bounded reads (at most three per turn), not by a full retrieval pass (' + String(counts.contextRecords) + ' over five turns)');
});

test('09-D the knowledge revocation key is carried per turn and never re-fingerprinted per rank', { timeout: 30000 }, async t => {
  const f = fixture(); t.after(f.cleanup);
  const store = f.open();
  store.append(scope(), [message('raw', '用户喜欢红茶')]);
  store.apply(change({ type: 'add', id: 'tea', text: '用户喜欢红茶', sourceIds: ['raw'] }, 'add-tea'));
  const clock = fakeClock();
  const books = knowledgeBooks({ libraryId: 'kb-one', blocks: [{ documentId: 'kd-1', ordinal: 0, text: '第一本手册的内容。' }] });
  const { port, snapshots } = prefixPort(store, async input => none(input), { clock, books: () => books.read(), knowledgeRevision: () => books.revision });
  const one = scope('companion', 'one');
  await port.append(one, [message('one:user', '开场')]);
  const c1 = await port.foregroundContext(one, 'one:user', '开场', null, signal());
  await port.appendAssistant(one, replyMessage(one, '开场回答'), c1, 'one:user', signal());
  await settle();
  const two = scope('companion', 'two');
  await port.append(two, [message('two:user', '第二句')]);
  const c2 = await port.foregroundContext(two, 'two:user', '第二句', null, signal());
  const key = snapshots.load(two)!.record.key;
  assert.equal(key.knowledge!.libraryId, 'kb-one', 'the snapshot key carries the library identity');
  assert.equal(key.knowledge!.libraryRevision, 1);
  assert.equal(key.knowledge!.revision, books.revision, 'and the real knowledge revocation revision');
  assert.ok(key.knowledgeFingerprint.length === 64, 'the delivered block set has its own stable fingerprint');
  assert.ok(c2.prefix!.text.includes('第一本手册的内容。'));
  // The same library, a new revocation revision: the key changes and the prefix is no longer the same one.
  books.removeDocument('kd-1');
  const three = scope('companion', 'three');
  await port.append(three, [message('three:user', '第三句')]);
  const c3 = await port.foregroundContext(three, 'three:user', '第三句', null, signal());
  assert.ok(!c3.prefix!.text.includes('第一本手册的内容。'), 'a removed document is gone from the next prefix');
  void SqliteMemoryStore;
});
