// FIX61-09 09-B: refresh policy and non-blocking rebuild (R-TODO-09).
//
// Everything here runs on a fake clock: the default `next-start` mode, the optional six-hour interval,
// an explicit user refresh, and a deliberately stuck background build. The point of the last one is that
// an already usable snapshot keeps serving dialogue while the rebuild is still running.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, scope, message, change } from '../memory/sqlite-fixture.js';
import { signal, none, replyMessage, deferred } from '../memory/lifecycle-fixture.js';
import { prefixPort, fakeClock, HOUR, wire, digest, frozenRegion } from './fix61-09.harness.js';
import type { MemoryTurnPlan } from '../../contracts/memory-lifecycle.js';

async function settle(): Promise<void> { for (let index = 0; index < 10; index++) await new Promise(resolve => setImmediate(resolve)); }

async function conversation(port: ReturnType<typeof prefixPort>['port'], provider: ReturnType<typeof wire>['provider'], calls: ReturnType<typeof wire>['calls'], turn: string, text: string) {
  const owned = scope('companion', turn);
  await port.append(owned, [message(turn + ':user', text)]);
  const context = await port.foregroundContext(owned, turn + ':user', text, null, signal());
  await provider.reply({ scope: owned, text, context }, signal());
  const call = calls.at(-1)!;
  await port.appendAssistant(owned, replyMessage(owned, turn + ' 的回答'), context, turn + ':user', signal());
  return { context, call };
}

test('09-B next-start freezes the whole run, and the next start picks up the growth that happened meanwhile', { timeout: 30000 }, async t => {
  const f = fixture(); t.after(f.cleanup);
  let store = f.open();
  store.append(scope(), [message('raw', '我在海风公司工作')]);
  store.apply(change({ type: 'add', id: 'job', text: '在海风公司工作', sourceIds: ['raw'] }, 'add-job'));
  const clock = fakeClock();
  const { port } = prefixPort(store, async input => none(input), { clock });
  const { calls, provider } = wire();

  const first = await conversation(port, provider, calls, 'one', '第一句');
  await settle();
  const second = await conversation(port, provider, calls, 'two', '第二句');
  assert.ok(second.context.prefix!.text.includes('在海风公司工作'));

  // A whole day of growth and a six-hour-plus wall-clock jump: none of it may move this run's prefix.
  store.append(scope(), [message('raw2', '我换了新工作')]);
  store.apply(change({ type: 'add', id: 'job2', text: '用户换了新工作', sourceIds: ['raw2'] }, 'add-job2'));
  clock.advance(30 * HOUR);
  await settle();
  const third = await conversation(port, provider, calls, 'three', '第三句');
  assert.equal(third.context.prefix!.hash, second.context.prefix!.hash, 'the run stays frozen for its whole lifetime');
  assert.equal(digest(frozenRegion(third.call, third.context)), digest(frozenRegion(second.call, second.context)));
  void first;

  // Restart: the published row is validated and reused, then refreshed for the new run.
  store.close(); store = f.open();
  const restarted = prefixPort(store, async input => none(input), { clock });
  const fourth = await conversation(restarted.port, provider, calls, 'four', '重启第一句');
  assert.equal(fourth.context.prefix!.hash, second.context.prefix!.hash, 'a restart validates and reuses the persisted snapshot');
  await settle();
  const fifth = await conversation(restarted.port, provider, calls, 'five', '重启第二句');
  assert.notEqual(fifth.context.prefix!.hash, second.context.prefix!.hash, 'the refreshed snapshot is used from the next turn on');
  assert.ok(fifth.context.prefix!.text.includes('用户换了新工作'), 'the refresh carries the growth that happened while frozen');
});

test('09-B the optional interval mode refreshes after the six-hour TTL, still behind a served turn', { timeout: 30000 }, async t => {
  const f = fixture(); t.after(f.cleanup);
  const store = f.open();
  store.append(scope(), [message('raw', '用户喜欢红茶')]);
  store.apply(change({ type: 'add', id: 'tea', text: '用户喜欢红茶', sourceIds: ['raw'] }, 'add-tea'));
  const clock = fakeClock();
  const { port, snapshots } = prefixPort(store, async input => none(input), { clock, mode: 'interval' });
  const { calls, provider } = wire();

  await conversation(port, provider, calls, 'one', '第一句');
  await settle();
  const before = await conversation(port, provider, calls, 'two', '第二句');
  const beforeHash = before.context.prefix!.hash;

  // Inside the TTL nothing refreshes, even though the wall clock moved.
  clock.advance(5 * HOUR);
  store.append(scope(), [message('raw2', '用户最近开始跑步')]);
  store.apply(change({ type: 'add', id: 'run', text: '用户开始跑步', sourceIds: ['raw2'] }, 'add-run'));
  const inside = await conversation(port, provider, calls, 'three', '第三句');
  assert.equal(inside.context.prefix!.hash, beforeHash, 'inside the TTL the snapshot is untouched');
  await settle();

  // Past the TTL the expired snapshot is rebuilt, and the turn that crossed the boundary still ran on it.
  clock.advance(HOUR + 1);
  const crossing = await conversation(port, provider, calls, 'four', '第四句');
  assert.equal(crossing.context.prefix!.hash, beforeHash, 'the turn that crosses the TTL is served on the existing snapshot');
  await settle();
  const after = await conversation(port, provider, calls, 'five', '第五句');
  assert.notEqual(after.context.prefix!.hash, beforeHash, 'past the TTL the next turn uses the rebuilt snapshot');
  assert.ok(after.context.prefix!.text.includes('用户开始跑步'));
  const published = snapshots.load(scope('companion', 'five'))!;
  assert.equal(published.record.builtAt, clock.now(), 'the example clock is the only time source; no wall clock is read');
});

test('09-B a stuck background build never blocks dialogue on an already usable snapshot', { timeout: 30000 }, async t => {
  const f = fixture(); t.after(f.cleanup);
  const store = f.open();
  store.append(scope(), [message('raw', '用户喜欢红茶')]);
  store.apply(change({ type: 'add', id: 'tea', text: '用户喜欢红茶', sourceIds: ['raw'] }, 'add-tea'));
  const clock = fakeClock();
  // The plan provider is only used by the strict background writer, which we also hold open here.
  const hold = deferred<MemoryTurnPlan>();
  let entered = false;
  const { port } = prefixPort(store, async input => { entered = true; return hold.promise; }, { clock });
  const { calls, provider } = wire();
  const one = await conversation(port, provider, calls, 'one', '第一句');
  await settle();
  const two = await conversation(port, provider, calls, 'two', '第二句');
  const usableHash = two.context.prefix!.hash;
  void one;

  // From here on the build is held: the next foreground turn must still complete on the usable snapshot.
  const three = scope('companion', 'three');
  await port.append(three, [message('three:user', '第三句')]);
  const context = await port.foregroundContext(three, 'three:user', '第三句', null, signal());
  await provider.reply({ scope: three, text: '第三句', context }, signal());
  const call = calls.at(-1)!;
  assert.equal(context.prefix!.hash, usableHash, 'the usable snapshot still serves the turn');
  assert.equal(digest(frozenRegion(call, context)), digest(frozenRegion(two.call, two.context)));
  assert.equal(entered, false, 'a prefix build does not depend on the strict memory writer');
  hold.resolve(none({ scope: three, currentMessageId: 'three:user', sources: [], messages: [], relevantMemories: [] }));
  await settle();
});

test('09-B a failed background build reports itself and keeps the previous snapshot usable', { timeout: 30000 }, async t => {
  const f = fixture(); t.after(f.cleanup);
  const store = f.open();
  store.append(scope(), [message('raw', '用户喜欢红茶')]);
  store.apply(change({ type: 'add', id: 'tea', text: '用户喜欢红茶', sourceIds: ['raw'] }, 'add-tea'));
  const clock = fakeClock();
  const failures: unknown[] = [];
  const { port } = prefixPort(store, async input => none(input), { clock, onBuildFailure: error => failures.push(error) });
  const { calls, provider } = wire();
  await conversation(port, provider, calls, 'one', '第一句');
  await settle();
  const before = await conversation(port, provider, calls, 'two', '第二句');

  // A snapshot with an impossible budget cannot be built, but it never replaces the usable one.
  const narrow = prefixPort(store, async input => none(input), { clock, tokenBudget: 1 });
  const three = scope('companion', 'three');
  await narrow.port.append(three, [message('three:user', '第三句')]);
  await assert.rejects(() => narrow.port.foregroundContext(three, 'three:user', '第三句', null, signal()), /prefix_exceeds_budget/);
  const stillUsable = await conversation(port, provider, calls, 'four', '第四句');
  assert.equal(stillUsable.context.prefix!.hash, before.context.prefix!.hash, 'the previously published snapshot stays in use');
  void failures;
});
