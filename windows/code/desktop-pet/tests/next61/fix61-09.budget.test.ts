// FIX61-09 09-E: measured comparison of the old dynamic mode and the frozen-snapshot mode.
//
// This case reports ONLY what this machine can actually measure: context assembly time, the serialized
// frozen-prefix bytes and the request size. It does NOT report TTFT, cache usage, cache-hit rate, cost or
// a tokenizer's token count: there is no authorized credential or model in this run, so those stay
// `unknown`. No fixed percentage saving is asserted anywhere, and none may be inferred from these numbers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, scope, message, change, NOW } from '../memory/sqlite-fixture.js';
import { signal, none, replyMessage } from '../memory/lifecycle-fixture.js';
import { prefixPort, dynamicPort, fakeClock, wire, frozenRegion } from './fix61-09.harness.js';

interface Row { turn: string; mode: 'dynamic' | 'frozen'; assembleMs: number; frozenBytes: number; suffixBytes: number; requestBytes: number; complete: boolean }
interface Turn { readonly text: string; readonly context: import('../../contracts/index.js').DialogueContext; readonly assembleMs: number }
const report: Row[] = [];
const UNKNOWN = 'unknown: no authorized credential or model in this run; nothing is inferred from a fixture';

async function conversation(port: ReturnType<typeof prefixPort>['port'], owned: ReturnType<typeof scope>, text: string) {
  await port.append(owned, [message(owned.turnId + ':user', text)]);
  const started = process.hrtime.bigint();
  const context = await port.foregroundContext(owned, owned.turnId + ':user', text, null, signal());
  const assembleMs = Number(process.hrtime.bigint() - started) / 1e6;
  await port.appendAssistant(owned, replyMessage(owned, owned.turnId + ' 的回答'), context, owned.turnId + ':user', signal());
  return { context, assembleMs };
}

test('09-E frozen and dynamic modes are compared on the same corpus with only measurable quantities', { timeout: 60000 }, async t => {
  const f = fixture(); t.after(f.cleanup);
  const store = f.open();
  store.append(scope(), [message('raw-a', '我在海风公司工作'), message('raw-b', '我养了一只叫团子的猫'), message('raw-c', '我最近在学做菜')]);
  store.apply(change({ type: 'add', id: 'job', text: '在海风公司工作', sourceIds: ['raw-a'] }, 'add-job'));
  store.apply(change({ type: 'add', id: 'cat', text: '猫叫团子', sourceIds: ['raw-b'] }, 'add-cat'));
  store.apply(change({ type: 'add', id: 'cook', text: '最近在学做菜', sourceIds: ['raw-c'] }, 'add-cook'));
  store.recordDerived(scope(), { id: 'sum-1', kind: 'summary', text: '用户聊过工作、猫和做饭。', sourceIds: ['raw-a'], createdAt: NOW });
  const clock = fakeClock();
  const corpus = ['聊聊今天吧', '猫最近怎么样', '工作上有什么进展', '我该做什么菜', '周末有什么建议'];

  // Mode A: the pre-existing dynamic assembly, unchanged: identity, summary, memories, history and the
  // current input are assembled from live retrieval on every single turn.
  const dynamic = dynamicPort(store, async input => none(input));
  const dynamicConversation: Turn[] = [];
  for (const [index, text] of corpus.entries()) dynamicConversation.push({ text, ...(await conversation(dynamic, scope('companion', 'dyn-' + String(index)), text)) });
  assert.ok(dynamicConversation.every(entry => entry.context.prefix === undefined), 'the dynamic mode has no frozen prefix');

  // Mode B: the frozen-snapshot mode on the SAME store, same corpus, same fixture model and provider.
  store.close();
  const reopened = f.open();
  const frozen = prefixPort(reopened, async input => none(input), { clock });
  const frozenConversation: Turn[] = [];
  for (const [index, text] of corpus.entries()) frozenConversation.push({ text, ...(await conversation(frozen.port, scope('companion', 'frz-' + String(index)), text)) });
  for (let index = 0; index < 10; index++) await new Promise(resolve => setImmediate(resolve));

  // Replay every turn through the real provider so both modes are measured on real wire bytes.
  const { calls, provider } = wire();
  const measure = async (entries: readonly Turn[], mode: 'dynamic' | 'frozen') => {
    for (const [index, entry] of entries.entries()) {
      calls.length = 0;
      await provider.reply({ scope: entry.context.scope, text: entry.text, context: entry.context }, signal());
      const call = calls[0]!;
      const frozen = entry.context.prefix ? Buffer.byteLength(frozenRegion(call, entry.context), 'utf8') : 0;
      const suffix = entry.context.prefix
        ? Buffer.byteLength(JSON.stringify(call.messages.slice(1 + entry.context.prefix.messages.length)), 'utf8')
        : Buffer.byteLength(JSON.stringify(call.messages), 'utf8');
      report.push({ turn: 'turn-' + String(index + 1), mode, assembleMs: Number(entry.assembleMs.toFixed(3)), frozenBytes: frozen, suffixBytes: suffix, requestBytes: Buffer.byteLength(JSON.stringify(call.messages), 'utf8'), complete: entry.context.prefix?.complete ?? false });
    }
  };
  await measure(dynamicConversation, 'dynamic');
  await measure(frozenConversation, 'frozen');

  const frozenRows = report.filter(row => row.mode === 'frozen');
  // The one thing freezing guarantees locally and provably: the leading bytes do not move.
  const leading = new Set(frozenRows.filter(row => row.complete).map(row => row.frozenBytes));
  assert.ok(leading.size > 0, 'at least one turn ran on a complete frozen prefix');
  const { calls: replayCalls, provider: replayProvider } = wire();
  const complete = frozenConversation.filter(entry => entry.context.prefix?.complete).slice(-2);
  assert.equal(complete.length, 2, 'two complete frozen turns were captured for the byte comparison');
  for (const entry of complete) await replayProvider.reply({ scope: entry.context.scope, text: entry.text, context: entry.context }, signal());
  assert.equal(Buffer.byteLength(frozenRegion(replayCalls[0]!, complete[0]!.context), 'utf8'), Buffer.byteLength(frozenRegion(replayCalls[1]!, complete[1]!.context), 'utf8'), 'the frozen region is byte-equal across turns');
  assert.equal(frozenRegion(replayCalls[0]!, complete[0]!.context), frozenRegion(replayCalls[1]!, complete[1]!.context), 'and character-for-character identical');

  // What this run can actually measure. Everything else is explicitly unknown.
  const summary = {
    mode: 'fixture transport; no authorized endpoint',
    corpusTurns: corpus.length,
    assemblyMs: {
      dynamic: dynamicConversation.map(entry => Number(entry.assembleMs.toFixed(3))),
      frozen: frozenConversation.map(entry => Number(entry.assembleMs.toFixed(3))),
    },
    bytes: { frozenPrefix: frozenRows.map(row => row.frozenBytes), dynamicTotal: report.filter(row => row.mode === 'dynamic').map(row => row.requestBytes) },
    ttft: UNKNOWN,
    cacheUsage: UNKNOWN,
    cacheHitRate: UNKNOWN,
    cost: UNKNOWN,
    inputTokens: UNKNOWN,
    note: 'A stable local prefix is a precondition for vendor cache reuse, not evidence of it. No saving ratio is claimed.',
  };
  console.log('FIX61-09 09-E measured report: ' + JSON.stringify(summary));
  assert.ok(report.length === corpus.length * 2);
  assert.ok(report.every(row => Number.isFinite(row.assembleMs) && row.assembleMs >= 0), 'every assembly is measured, none is estimated');
  assert.equal(summary.ttft, UNKNOWN, 'TTFT is unknown without a real endpoint');
  assert.equal(summary.cost, UNKNOWN);
});
