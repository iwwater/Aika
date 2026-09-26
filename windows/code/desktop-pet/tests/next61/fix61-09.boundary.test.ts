// FIX61-09 boundary cases (SPEC §2): what freezing must NOT do.
//
// These are the edges that a "cache" optimization tends to quietly violate:
//   * the frozen prefix must not carry a turn id, a wall-clock timestamp or anything random, so two
//     runs of one snapshot serialize to the same bytes;
//   * an over-budget dynamic suffix must be trimmed, while the frozen prefix itself must NEVER be
//     silently truncated turn by turn - it either fits (checked at build time) or the caller is told;
//   * a correction, a forget, a knowledge switch/removal, a prompt edit or a tightened privacy hold
//     must invalidate the frozen prefix immediately, and the next turn must first run on a safe
//     minimal prefix; when even that cannot be built (an impossible budget) the turn is refused
//     visibly instead of being served on unbounded content;
//   * the frozen prefix must be the FIRST part of the serialized request.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, scope, message, change } from '../memory/sqlite-fixture.js';
import { signal, none, replyMessage } from '../memory/lifecycle-fixture.js';
import { prefixPort, wire, frozenRegion, dynamicSuffix, digest, fakeClock } from './fix61-09.harness.js';
import type { DialogueContext, TurnScope } from '../../contracts/index.js';

async function settle(): Promise<void> { for (let index = 0; index < 10; index++) await new Promise(resolve => setImmediate(resolve)); }

/** One committed turn pair, so the next foreground turn has a full snapshot to talk on. */
async function seed(port: ReturnType<typeof prefixPort>['port'], id: string, text: string, answer: string): Promise<void> {
  const owned = scope('companion', id);
  await port.append(owned, [message(id + ':user', text)]);
  const context = await port.foregroundContext(owned, id + ':user', text, null, signal());
  await port.appendAssistant(owned, replyMessage(owned, answer), context, id + ':user', signal());
  await settle();
}

const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/;

test('09-boundary the frozen prefix carries no turn id, no timestamp and no random ordering', { timeout: 30000 }, async t => {
  const f = fixture(); t.after(f.cleanup);
  const store = f.open();
  store.append(scope(), [message('raw', '用户喜欢红茶')]);
  store.apply(change({ type: 'add', id: 'tea', text: '用户喜欢红茶', sourceIds: ['raw'] }, 'add-tea'));
  const { port } = prefixPort(store, async input => none(input), { clock: fakeClock() });
  const { calls, provider } = wire();
  await seed(port, 'one', '第一句', '第一句回答');

  const two = scope('companion', 'two');
  await port.append(two, [message('two:user', '第二句')]);
  const c2 = await port.foregroundContext(two, 'two:user', '第二句', null, signal());
  const w2 = await provider.reply({ scope: two, text: '第二句', context: c2 }, signal()).then(() => calls.at(-1)!);
  const frozen = frozenRegion(w2, c2);

  // A turn id inside the stable head would make every turn's leading bytes different.
  for (const turnId of ['one', 'two', 'three', 'two:user', 'one:user']) {
    assert.ok(!frozen.includes(turnId), 'the frozen prefix must not carry the turn id ' + turnId);
  }
  assert.equal(ISO.test(frozen), false, 'the frozen prefix must not carry a wall-clock timestamp');
  assert.ok(!frozen.includes('createdAt'), 'and no per-turn metadata field');

  // The frozen history is in snapshot order, so replaying the same turn reproduces the same bytes.
  const replay = await provider.reply({ scope: two, text: '第二句', context: c2 }, signal()).then(() => calls.at(-1)!);
  assert.equal(frozenRegion(replay, c2), frozen, 'one snapshot serializes to one byte string, deterministically');
  assert.equal(digest(frozenRegion(replay, c2)), digest(frozen));
});

test('09-boundary the dynamic suffix is what a budget trims; the frozen prefix is delivered whole', { timeout: 30000 }, async t => {
  const f = fixture(); t.after(f.cleanup);
  const store = f.open();
  store.append(scope(), [message('raw', '用户喜欢红茶')]);
  store.apply(change({ type: 'add', id: 'tea', text: '用户喜欢红茶', sourceIds: ['raw'] }, 'add-tea'));
  const { port } = prefixPort(store, async input => none(input), { clock: fakeClock(), suffixBytes: 4096 });
  const { calls, provider } = wire();
  await seed(port, 'one', '第一句', '第一句回答');

  const two = scope('companion', 'two');
  await port.append(two, [message('two:user', '第二句')]);
  const c2 = await port.foregroundContext(two, 'two:user', '第二句', null, signal());
  const w2 = await provider.reply({ scope: two, text: '第二句', context: c2 }, signal()).then(() => calls.at(-1)!);

  // The frozen head is delivered in full: nothing shaves it to make room for the tail.
  assert.equal(w2.messages[0]!.content, c2.prefix!.text, 'the frozen text is delivered whole, never shaved');
  assert.equal(c2.prefix!.suffixBytes, 4096, 'the carried budget bounds the tail, not the head');
  assert.ok(frozenRegion(w2, c2).includes('用户喜欢红茶'), 'the frozen memory is not dropped to make room');
  assert.equal(typeof w2.body.suffixBytes, 'number', 'the request reports its own measured suffix size');
  // The dynamic tail is the only region a budget may trim: it carries the current input last.
  const suffix = dynamicSuffix(w2, c2);
  assert.ok(suffix.includes('第二句'), 'the current input rides in the trimmable tail');
  assert.ok(!frozenRegion(w2, c2).includes('第二句'), 'and never in the frozen head');
});

test('09-boundary a prefix that cannot fit its own budget is refused, never silently truncated', { timeout: 30000 }, async t => {
  const f = fixture(); t.after(f.cleanup);
  const store = f.open();
  store.append(scope(), [message('raw', '用户喜欢红茶')]);
  store.apply(change({ type: 'add', id: 'tea', text: '用户喜欢红茶', sourceIds: ['raw'] }, 'add-tea'));
  // One byte of budget: nothing can be built, and the refusal must be visible to the caller.
  const { port } = prefixPort(store, async input => none(input), { clock: fakeClock(), tokenBudget: 1 });
  const owned = scope('companion', 'narrow');
  await port.append(owned, [message('narrow:user', '这句话')]);
  await assert.rejects(
    () => port.foregroundContext(owned, 'narrow:user', '这句话', null, signal()),
    /prefix_exceeds_budget/,
    'an impossible prefix is a configuration error, not a shaved prefix'
  );
  // The refusal is visible, and no snapshot was published behind it.
  assert.equal(port.peekSnapshot(owned), null, 'nothing was published from the refused build');
});

test('09-boundary the frozen prefix is the first part of every serialized request', { timeout: 30000 }, async t => {
  const f = fixture(); t.after(f.cleanup);
  const store = f.open();
  store.append(scope(), [message('raw', '用户喜欢红茶')]);
  store.apply(change({ type: 'add', id: 'tea', text: '用户喜欢红茶', sourceIds: ['raw'] }, 'add-tea'));
  const { port } = prefixPort(store, async input => none(input), { clock: fakeClock() });
  const { calls, provider } = wire();
  await seed(port, 'one', '第一句', '第一句回答');
  const two = scope('companion', 'two');
  await port.append(two, [message('two:user', '第二句')]);
  const c2 = await port.foregroundContext(two, 'two:user', '第二句', null, signal());
  const call = await provider.reply({ scope: two, text: '第二句', context: c2 }, signal()).then(() => calls.at(-1)!);
  assert.equal(call.messages[0]!.role, 'system', 'the stable block leads the request');
  assert.equal(call.messages[0]!.content, c2.prefix!.text, 'and it is the frozen text byte for byte');
  assert.equal(JSON.stringify(call.messages.slice(1, 1 + c2.prefix!.messages.length).map(item => ({ role: item.role, content: item.content }))),
    JSON.stringify(c2.prefix!.messages.map(item => ({ role: item.role, content: item.text }))),
    'the frozen history follows immediately, in snapshot order');
});

test('09-boundary a correction revokes the frozen prefix and the next turn runs on the safe minimal prefix', { timeout: 30000 }, async t => {
  const f = fixture(); t.after(f.cleanup);
  const store = f.open();
  store.append(scope(), [message('raw', '我在海风公司工作')]);
  store.apply(change({ type: 'add', id: 'job', text: '在海风公司工作', sourceIds: ['raw'] }, 'add-job'));
  const { port } = prefixPort(store, async input => none(input), { clock: fakeClock() });
  await seed(port, 'one', '开场', '开场回答');
  const two = scope('companion', 'two');
  await port.append(two, [message('two:user', '第二句')]);
  const c2 = await port.foregroundContext(two, 'two:user', '第二句', null, signal());
  assert.ok(c2.prefix!.text.includes('在海风公司工作'), 'the snapshot pinned the memory');

  // A correction is a revocation, not ordinary growth: the old text must stop being delivered.
  store.apply(change({ type: 'update', id: 'job', expectedVersion: 1, text: '在湖山公司工作', sourceIds: ['raw'] }, 'correct-job'));
  assert.throws(() => port.assertContextCurrent(c2), /stale_context/, 'the issued context is revoked by the correction');

  const three = scope('companion', 'three');
  await port.append(three, [message('three:user', '第三句')]);
  const c3 = await port.foregroundContext(three, 'three:user', '第三句', null, signal());
  assert.equal(c3.prefix!.complete, false, 'the next turn first runs on the safe minimal prefix');
  assert.ok(!c3.prefix!.text.includes('在海风公司工作'), 'the corrected-away text is not delivered while rebuilding');
  await settle();
  const four = scope('companion', 'four');
  await port.append(four, [message('four:user', '第四句')]);
  const c4 = await port.foregroundContext(four, 'four:user', '第四句', null, signal());
  assert.equal(c4.prefix!.complete, true, 'and the rebuilt snapshot is a full one');
  assert.ok(c4.prefix!.text.includes('在湖山公司工作'), 'carrying the corrected content');
  assert.ok(!c4.prefix!.text.includes('在海风公司工作'));
});

test('09-boundary a tightened privacy hold revokes the frozen prefix immediately', { timeout: 30000 }, async t => {
  const f = fixture(); t.after(f.cleanup);
  const store = f.open();
  store.append(scope(), [message('raw', '用户喜欢红茶')]);
  store.apply(change({ type: 'add', id: 'tea', text: '用户喜欢红茶', sourceIds: ['raw'] }, 'add-tea'));
  const { port } = prefixPort(store, async input => none(input), { clock: fakeClock() });
  await seed(port, 'one', '开场', '开场回答');
  const two = scope('companion', 'two');
  await port.append(two, [message('two:user', '第二句')]);
  const c2 = await port.foregroundContext(two, 'two:user', '第二句', null, signal());
  assert.ok(c2.prefix!.text.includes('用户喜欢红茶'));

  // Tightening the privacy boundary is a revocation: the frozen prefix stops being allowed at once.
  // `pending.begin` is the production privacy hold - the same one a real correction/forget request opens.
  store.pending.begin(two, 'two:user', 1, 'forget');
  assert.throws(() => port.assertContextCurrent(c2), /stale_context/, 'a tightened hold revokes the issued context');

  const three = scope('companion', 'three');
  await port.append(three, [message('three:user', '第三句')]);
  const c3 = await port.foregroundContext(three, 'three:user', '第三句', null, signal());
  assert.ok(!c3.prefix!.text.includes('用户喜欢红茶'), 'the held turn’s context is not delivered while the hold is open');
  await port.appendAssistant(three, replyMessage(three, '第三句回答'), c3, 'three:user', signal());
  store.pending.cancel(two, 'two:user');
  await settle();
  const four = scope('companion', 'four');
  await port.append(four, [message('four:user', '第四句')]);
  const c4 = await port.foregroundContext(four, 'four:user', '第四句', null, signal());
  // Releasing a hold restores the previous privacy revision, so the snapshot that was only fenced off -
  // never revoked by a content change - becomes usable again. Asserting a specific timing here would be
  // a guess, so this asserts what must hold either way: nothing beyond the restored boundary is leaked,
  // and the port recovers rather than sticking on the minimal prefix forever.
  await port.appendAssistant(four, replyMessage(four, '第四句回答'), c4, 'four:user', signal());
  await settle();
  const five = scope('companion', 'five');
  await port.append(five, [message('five:user', '第五句')]);
  const c5 = await port.foregroundContext(five, 'five:user', '第五句', null, signal());
  assert.equal(c5.prefix!.complete, true, 'the released boundary recovers to a full snapshot');
  assert.ok(c5.prefix!.text.includes('用户喜欢红茶'), 'and nothing outside the released boundary is leaked');
});

test('09-boundary the frozen prefix is bound to one conversation boundary', { timeout: 30000 }, async t => {
  const f = fixture(); t.after(f.cleanup);
  const store = f.open();
  store.append(scope(), [message('raw', '用户喜欢红茶')]);
  store.apply(change({ type: 'add', id: 'tea', text: '用户喜欢红茶', sourceIds: ['raw'] }, 'add-tea'));
  const { port, snapshots } = prefixPort(store, async input => none(input), { clock: fakeClock() });
  const { calls, provider } = wire();
  await seed(port, 'one', '第一句', '第一句回答');
  const two = scope('companion', 'two');
  await port.append(two, [message('two:user', '第二句')]);
  const c2 = await port.foregroundContext(two, 'two:user', '第二句', null, signal());
  const w2 = await provider.reply({ scope: two, text: '第二句', context: c2 }, signal()).then(() => calls.at(-1)!);

  // A different session is a different boundary: it must not inherit this snapshot's frozen bytes.
  const other: TurnScope = { characterId: 'companion', sessionId: 'another-session', turnId: 'x', generation: 1 };
  await port.append(other, [message('x:user', '另一句')]);
  const cx = await port.foregroundContext(other, 'x:user', '另一句', null, signal());
  const wx = await provider.reply({ scope: other, text: '另一句', context: cx }, signal()).then(() => calls.at(-1)!);
  assert.notEqual(cx.prefix!.id, c2.prefix!.id, 'another session pins its own snapshot');
  assert.notEqual(frozenRegion(wx, cx), frozenRegion(w2, c2), 'and never reuses this boundary’s frozen bytes');
  assert.ok(snapshots.load(other) === null || snapshots.load(other)!.record.key.sessionId === 'another-session');
  void (null as unknown as DialogueContext);
});
