// FIX61-09 09-A: frozen prefix byte stability (R-TODO-09).
//
// The claim under test is deliberately narrow: freezing makes the LOCAL request stable, so the same
// snapshot serializes to the same leading bytes turn after turn. It is NOT a claim about a provider KV
// cache hit rate, a cost reduction or a lower logical input token count.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, scope, message, change, NOW } from '../memory/sqlite-fixture.js';
import { signal, replyMessage, none } from '../memory/lifecycle-fixture.js';
import { prefixPort, wire, frozenRegion, dynamicSuffix, digest, fakeClock, occurrences } from './fix61-09.harness.js';

async function settle(): Promise<void> { for (let index = 0; index < 8; index++) await new Promise(resolve => setImmediate(resolve)); }

test('09-A one snapshot keeps the serialized frozen prefix identical across turns while only the suffix moves', { timeout: 30000 }, async t => {
  const f = fixture(); t.after(f.cleanup);
  const store = f.open();
  store.append(scope(), [message('raw', '我喜欢红茶')]);
  store.apply(change({ type: 'add', id: 'tea', text: '用户喜欢红茶', sourceIds: ['raw'] }, 'add-tea'));
  store.recordDerived(scope(), { id: 'sum-1', kind: 'summary', text: '最近聊过喝茶。', sourceIds: ['raw'], createdAt: NOW });
  const { port } = prefixPort(store, async input => none(input), { clock: fakeClock() });
  const { calls, provider } = wire();

  // Turn 1 completes the pair, so the snapshot can pin a whole turn and the next turn already has one.
  const one = scope('companion', 'one');
  await port.append(one, [message('one:user', '第一句话')]);
  const c1 = await port.foregroundContext(one, 'one:user', '第一句话', null, signal());
  await port.appendAssistant(one, replyMessage(one, '第一句回答'), c1, 'one:user', signal());
  await settle();

  const second = scope('companion', 'two');
  await port.append(second, [message('two:user', '第二句话')]);
  const c2 = await port.foregroundContext(second, 'two:user', '第二句话', null, signal());
  const w2 = await provider.reply({ scope: second, text: '第二句话', context: c2 }, signal()).then(() => calls.at(-1)!);

  const third = scope('companion', 'three');
  await port.append(third, [message('three:user', '第三句话')]);
  const c3 = await port.foregroundContext(third, 'three:user', '第三句话', null, signal());
  const w3 = await provider.reply({ scope: third, text: '第三句话', context: c3 }, signal()).then(() => calls.at(-1)!);

  assert.ok(c2.prefix, 'a foreground turn exposes the frozen prefix it pinned');
  assert.ok(c3.prefix);
  assert.equal(c3.prefix.id, c2.prefix.id, 'the run stays frozen on one snapshot');
  assert.equal(c3.prefix.hash, c2.prefix.hash);
  const r2 = frozenRegion(w2, c2), r3 = frozenRegion(w3, c3);
  assert.equal(digest(r3), digest(r2), 'the serialized frozen prefix hash is unchanged');
  assert.equal(Buffer.byteLength(r3, 'utf8'), Buffer.byteLength(r2, 'utf8'), 'prefix byte length is unchanged');

  const suffix2 = dynamicSuffix(w2, c2), suffix3 = dynamicSuffix(w3, c3);
  assert.notEqual(digest(suffix3), digest(suffix2), 'the dynamic suffix is what actually changes between turns');
  assert.ok(suffix3.includes('第三句话'), 'the current input rides in the dynamic suffix');
  assert.ok(!r3.includes('第三句话'), 'no current input may leak into the frozen prefix');

  const serialized3 = JSON.stringify(w3.messages);
  assert.equal(occurrences(serialized3, '第三句话'), 1, 'the current input appears exactly once');
  assert.equal(occurrences(serialized3, '第一句话'), 1, 'a frozen earlier turn appears exactly once');
  assert.equal(occurrences(serialized3, '第一句回答'), 1);
  assert.equal(occurrences(serialized3, '第二句话'), 1, 'the turn after the snapshot is in the suffix exactly once');
  assert.equal(occurrences(serialized3, '用户喜欢红茶'), 1, 'a frozen memory is not repeated in the suffix');
  assert.equal(occurrences(serialized3, '最近聊过喝茶。'), 1, 'the frozen summary is not repeated in the suffix');
});

test('09-A ordinary memory growth does not rewrite a published prefix, and the next run does pick it up', { timeout: 30000 }, async t => {
  const f = fixture(); t.after(f.cleanup);
  const store = f.open();
  store.append(scope(), [message('raw', '我在海风公司工作')]);
  store.apply(change({ type: 'add', id: 'job', text: '在海风公司工作', sourceIds: ['raw'] }, 'add-job'));
  const clock = fakeClock();
  const { port } = prefixPort(store, async input => none(input), { clock });
  const { calls, provider } = wire();

  const one = scope('companion', 'one');
  await port.append(one, [message('one:user', '开场')]);
  const c1 = await port.foregroundContext(one, 'one:user', '开场', null, signal());
  await port.appendAssistant(one, replyMessage(one, '开场回答'), c1, 'one:user', signal());
  await settle();

  const two = scope('companion', 'two');
  await port.append(two, [message('two:user', '问一句')]);
  const c2 = await port.foregroundContext(two, 'two:user', '问一句', null, signal());
  const w2 = await provider.reply({ scope: two, text: '问一句', context: c2 }, signal()).then(() => calls.at(-1)!);

  // Ordinary growth after the snapshot: a new automatic memory must not rewrite the frozen prefix.
  store.append(scope(), [message('raw2', '我今天买了新键盘')]);
  store.apply(change({ type: 'add', id: 'keyboard', text: '用户买了新键盘', sourceIds: ['raw2'] }, 'add-keyboard'));
  await settle();

  const three = scope('companion', 'three');
  await port.append(three, [message('three:user', '又问一句')]);
  const c3 = await port.foregroundContext(three, 'three:user', '又问一句', null, signal());
  const w3 = await provider.reply({ scope: three, text: '又问一句', context: c3 }, signal()).then(() => calls.at(-1)!);
  assert.equal(c3.prefix!.hash, c2.prefix!.hash, 'ordinary growth must not rewrite the frozen prefix');
  assert.equal(digest(frozenRegion(w3, c3)), digest(frozenRegion(w2, c2)), 'prefix bytes stay stable while memories keep growing');
  assert.ok(!c3.prefix!.text.includes('用户买了新键盘'), 'a post-snapshot memory is never silently injected into the prefix');

  // A restart is the documented refresh point: the next run's snapshot includes the new memory.
  store.close();
  const reopened = f.open();
  const restarted = prefixPort(reopened, async input => none(input), { clock }).port;
  const four = scope('companion', 'four');
  await restarted.append(four, [message('four:user', '重启后第一句')]);
  const c4 = await restarted.foregroundContext(four, 'four:user', '重启后第一句', null, signal());
  await restarted.appendAssistant(four, replyMessage(four, '重启后回答'), c4, 'four:user', signal());
  await settle();
  const five = scope('companion', 'five');
  await restarted.append(five, [message('five:user', '重启后第二句')]);
  const c5 = await restarted.foregroundContext(five, 'five:user', '重启后第二句', null, signal());
  assert.notEqual(c5.prefix!.hash, c2.prefix!.hash, 'the next start refreshes the frozen prefix');
  assert.ok(c5.prefix!.text.includes('用户买了新键盘'), 'the refreshed snapshot carries the memory that grew while frozen');
});

test('09-A the frozen prefix is the same for a text turn and a voice turn of one snapshot', { timeout: 30000 }, async t => {
  const f = fixture(); t.after(f.cleanup);
  const store = f.open();
  store.append(scope(), [message('raw', '用户住在杭州')]);
  store.apply(change({ type: 'add', id: 'city', text: '用户住在杭州', sourceIds: ['raw'] }, 'add-city'));
  const { port } = prefixPort(store, async input => none(input), { clock: fakeClock() });
  const { calls, provider } = wire();
  const one = scope('companion', 'one');
  await port.append(one, [message('one:user', '开场')]);
  const c1 = await port.foregroundContext(one, 'one:user', '开场', null, signal());
  await port.appendAssistant(one, replyMessage(one, '开场回答'), c1, 'one:user', signal());
  await settle();

  // A voice turn carries a perception object; perception is volatile and must never enter the prefix.
  const two = scope('companion', 'two');
  await port.append(two, [message('two:user', '语音这句话')]);
  const perception = { scope: two, transcript: '语音这句话', status: 'complete' as const, emotion: 'happy' as const, modalities: [], cues: [] };
  const c2 = await port.foregroundContext(two, 'two:user', '语音这句话', perception, signal());
  const w2 = await provider.reply({ scope: two, text: '语音这句话', context: c2 }, signal()).then(() => calls.at(-1)!);
  const frozen2 = frozenRegion(w2, c2);
  assert.ok(!frozen2.includes('happy'), 'per-turn perception never enters the frozen prefix');
  await port.appendAssistant(two, replyMessage(two, '语音回答'), c2, 'two:user', signal());
  await settle();

  const three = scope('companion', 'three');
  await port.append(three, [message('three:user', '文字这句话')]);
  const c3 = await port.foregroundContext(three, 'three:user', '文字这句话', null, signal());
  const w3 = await provider.reply({ scope: three, text: '文字这句话', context: c3 }, signal()).then(() => calls.at(-1)!);
  assert.equal(digest(frozenRegion(w3, c3)), digest(frozen2), 'a voice turn and a text turn serialize the same frozen prefix');
});

test('09-A the frozen prefix does not drift when the run crosses a six-hour wall-clock boundary', { timeout: 30000 }, async t => {
  const f = fixture(); t.after(f.cleanup);
  const store = f.open();
  const clock = fakeClock();
  const { port } = prefixPort(store, async input => none(input), { clock });
  const { calls, provider } = wire();
  const one = scope('companion', 'one');
  await port.append(one, [message('one:user', '开场')]);
  const c1 = await port.foregroundContext(one, 'one:user', '开场', null, signal());
  await port.appendAssistant(one, replyMessage(one, '开场回答'), c1, 'one:user', signal());
  await settle();
  const two = scope('companion', 'two');
  await port.append(two, [message('two:user', '长时间后的第一句')]);
  const c2 = await port.foregroundContext(two, 'two:user', '长时间后的第一句', null, signal());
  const w2 = await provider.reply({ scope: two, text: '长时间后的第一句', context: c2 }, signal()).then(() => calls.at(-1)!);
  // The default mode freezes this run in place: wall-clock time is not a reason to rebuild behind the user.
  clock.advance(24 * 3_600_000);
  const three = scope('companion', 'three');
  await port.append(three, [message('three:user', '一天以后的第二句')]);
  const c3 = await port.foregroundContext(three, 'three:user', '一天以后的第二句', null, signal());
  const w3 = await provider.reply({ scope: three, text: '一天以后的第二句', context: c3 }, signal()).then(() => calls.at(-1)!);
  assert.equal(c3.prefix!.hash, c2.prefix!.hash, 'the default next-start mode keeps this run frozen');
  assert.equal(digest(frozenRegion(w3, c3)), digest(frozenRegion(w2, c2)));
  assert.ok(!frozenRegion(w3, c3).includes('一天以后的第二句'));
});
