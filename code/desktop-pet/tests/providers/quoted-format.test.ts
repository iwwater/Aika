import { MEMORY_DYNAMICS_PROMPT } from '../../providers/memory-dynamics-plan.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMemoryTurnFormat } from '../../providers/memory-turn-format.js';
import { MemoryWire, checkedTurn, type MemoryWireMode } from '../../providers/memory-wire.js';
import { MEMORY_TURN_PROMPT, SUMMARY_PROMPT } from '../../providers/memory-lifecycle-prompt.js';
import { QwenMemoryTurnProvider, QwenSummaryProvider } from '../../providers/qwen-memory-lifecycle.js';
import { ProviderTransport } from '../../providers/transport.js';
import { input, source, ref, retained, plan, change, harness, config, signal, scope } from './quoted-helpers.js';

test('numeric-v1 stays default; unknown modes fail before transport and quoted output never falls back', async () => {
  const data = input(), legacy = buildMemoryTurnFormat(data);
  assert.equal(legacy.mode, 'numeric-v1'); assert.equal(legacy.system, MEMORY_TURN_PROMPT);
  assert.deepEqual(legacy.data, new MemoryWire(checkedTurn(data)).data(data.currentMessageId));
  assert.equal(Buffer.byteLength(MEMORY_TURN_PROMPT), 8023); assert.equal(Buffer.byteLength(SUMMARY_PROMPT), 772);
  for (const mode of ['guess', '', null, 2]) {
    assert.throws(() => buildMemoryTurnFormat(data, mode as MemoryWireMode), /Unknown memory wire mode/);
    assert.throws(() => new QwenMemoryTurnProvider(config, undefined, mode as MemoryWireMode), /Unknown memory wire mode/);
  }
  const quoted = plan({ suppressSources: [ref('s1')], retainSources: [retained('后句。')] });
  const numeric = plan({ suppressSources: [ref('s1')], retainSources: [{ source: ref('s1'), fragmentId: 'f0', start: 7, end: 10, supportSourceIds: [] }] });
  for (const [body, mode] of [[quoted, 'numeric-v1'], [numeric, 'quoted-v2']] as const) {
    const run = harness(body, mode); await assert.rejects(run.provider.plan(data, signal()), /Invalid memory JSON fields/); assert.equal(run.requests.length, 1);
  }
});

test('provider and pure format builder emit the same system/data while summary retains numeric aliases', async () => {
  const data = input([...input().sources, source('memory', '事实', { kind: 'memory', messageRole: null, sourceVersions: [ref('old:user')] })]);
  const before = structuredClone(data), formatted = buildMemoryTurnFormat(data, 'quoted-v2'), run = harness(plan());
  await run.provider.plan(data, signal());
  assert.deepEqual(run.requests[0].messages, [{ role: 'system', content: formatted.system }, { role: 'user', content: JSON.stringify(formatted.data) }]);
  assert.deepEqual(data, before); assert.notEqual(formatted.input, data);
  const rows = [...(formatted.data as any).evidence, (formatted.data as any).currentMessage];
  assert.equal(rows.filter(row => row.kind === 'memory')[0].id, 'm0');
  assert.equal(JSON.stringify(formatted.data).split(data.sources[0]!.text).length - 1, 1);
  const transport = new ProviderTransport(async (_url, init) => {
    const body = JSON.parse(String(init?.body)), wire = JSON.parse(body.messages[1].content);
    assert.equal(body.messages[0].content, SUMMARY_PROMPT); assert.ok(wire.sources.every((s: any) => s.id.startsWith('s')));
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ text: '有效摘要', sourceVersions: wire.sources.map((s: any) => ref(s.id, s.version)) }) } }] });
  });
  await new QwenSummaryProvider(config, transport).summarize({ scope, sources: data.sources }, signal());
});

test('exact quotes preserve Unicode code points, whitespace, combining marks and overlapping matches', async () => {
  const text = ' 甲😀e\u0301乙 aaab 我不喝咖啡。';
  const data = input([source('current:user', '当前'), source('old:user', text)]);
  for (const quote of [' 甲😀e\u0301', '😀', 'e\u0301', '我不喝咖啡。', '\u0301']) {
    const out = await harness(plan({ suppressSources: [ref('s1')], retainSources: [retained(quote)] })).provider.plan(data, signal());
    const row = out.retainSources![0]!;
    assert.equal(Array.from(text).slice(row.start, row.end).join(''), quote); assert.deepEqual(Object.keys(row), ['source', 'fragmentId', 'start', 'end', 'supportSourceIds']);
    assert.equal(row.start, Array.from(text.slice(0, text.indexOf(quote))).length);
  }
  for (const quote of ['', '  ', 'é', '甲乙', 'aa', '😀😀', null]) {
    const run = harness(plan({ suppressSources: [ref('s1')], retainSources: [retained(quote)] }));
    await assert.rejects(run.provider.plan(data, signal())); assert.equal(run.requests.length, 1);
  }
  const repeat = input([source('current:user', '当前'), source('old:user', 'aaa')]);
  const out = await harness(plan({ suppressSources: [ref('s1')], retainSources: [retained('aa', { start: 1, end: 3 })] })).provider.plan(repeat, signal());
  assert.equal(out.retainSources![0]!.start, 1);
  for (const range of [{ start: 0, end: 1 }, { start: -1, end: 2 }, { start: '0', end: 2 }, { start: 0.5, end: 2 }, { start: 0, end: 9 }, { start: 1, end: 1 }, {}, { start: 0, end: 2, extra: true }, undefined]) {
    await assert.rejects(harness(plan({ suppressSources: [ref('s1')], retainSources: [{ ...retained('aa'), range }] })).provider.plan(repeat, signal()));
  }
});

test('quoted retentions keep strict field, version, eligibility and cross-fragment overlap rejection', async () => {
  const valid = retained('后句。'), data = input();
  for (const rows of [[{ ...valid, extra: true }], [{ ...valid, source: ref('s1', 9) }], [{ ...valid, fragmentId: 'f01' }], [valid, { ...valid, fragmentId: 'f1' }], [valid, valid]]) {
    await assert.rejects(harness(plan({ suppressSources: [ref('s1')], retainSources: rows })).provider.plan(data, signal()));
  }
  await assert.rejects(harness(plan({ retainSources: [valid] })).provider.plan(data, signal()), /explicitly suppressed/);
  const display = input([source('current:user', '当前'), source('old:user', '后句。', { messageRole: 'assistant', evidenceEligible: false })]);
  await assert.rejects(harness(plan({ suppressSources: [ref('s1')], retainSources: [valid] })).provider.plan(display, signal()), /readable/);
});

test('typed aliases enforce kind and m/u/f identity boundaries without changing numeric fresh IDs', async () => {
  const data = input([source('s0', '当前'), source('m0', '记忆', { kind: 'memory', messageRole: null, sourceVersions: [ref('f0')] }), source('summary', '摘要', { kind: 'summary', messageRole: null, sourceVersions: [ref('u3')] })]);
  const f = buildMemoryTurnFormat(data, 'quoted-v2'), rows = [...(f.data as any).evidence, (f.data as any).currentMessage];
  for (const row of rows) assert.ok(!['s0', 'm0', 'f0', 'u3'].includes(row.id));
  assert.equal(rows.find(r => r.kind === 'memory').id, 'm1');
  const ordinary = input([...input().sources, source('mem', 'memory', { kind: 'memory', messageRole: null })]);
  for (const bad of [plan({ suppressSources: [ref('m0')] }), plan({ changes: [change({ type: 'soft_delete', id: 's1', expectedVersion: 1 })] }), plan({ changes: [change({ type: 'soft_delete', id: 'f0', expectedVersion: 1 })] }), plan({ suppressSources: [ref('u0')] })]) await assert.rejects(harness(bad).provider.plan(ordinary, signal()));
  for (const id of ['m99', 'm01', 's99', 'u0', 'f0']) await assert.rejects(harness(plan({ changes: [change({ type: 'add', id, text: '新事实', sourceIds: ['s0'] })] })).provider.plan(input(), signal()), /collides/);
  assert.equal((await harness(plan({ changes: [change({ type: 'add', id: 'm99', text: '新事实', sourceIds: ['s0'] })] }), 'numeric-v1').provider.plan(input(), signal())).changes.length, 1);
  const ancestor = input([...input().sources, source('sum', '摘要', { kind: 'summary', messageRole: null, sourceVersions: [ref('f0')] })]);
  await assert.rejects(harness(plan({ suppressSources: [ref('s1')], retainSources: [retained('后句。')] })).provider.plan(ancestor, signal()), /colliding fragment/);
});

test('quoted fragment dependencies reject cycles and modified or unavailable supports', async () => {
  const data = input([...input().sources, source('sum', '后句。', { kind: 'summary', messageRole: null, sourceVersions: [ref('old:user')] }), source('mem', '原记忆', { kind: 'memory', messageRole: null }), source('derived', '派生', { kind: 'summary', messageRole: null, sourceVersions: [ref('mem')] })]);
  for (const support of [['f1'], ['s1'], ['u0'], ['m0'], ['s3']]) {
    const body = plan({ suppressSources: [ref('s1'), ref('s2')], retainSources: [retained('后句。'), retained('后句。', null, 's2', 'f1', support)], changes: [change({ type: 'update', id: 'm0', expectedVersion: 1, text: '新记忆', sourceIds: ['s0'] })] });
    await assert.rejects(harness(body).provider.plan(data, signal()));
  }
  const good = plan({ suppressSources: [ref('s1'), ref('s2')], retainSources: [retained('后句。'), retained('后句。', null, 's2', 'f1', ['f0'])] });
  assert.deepEqual((await harness(good).provider.plan(data, signal())).retainSources![1]!.supportSourceIds, ['f0']);
});

test('quoted request snapshots isolate concurrent roles, source mutations and cancelled late results', async () => {
  const first = input([...input().sources, source('first-memory', '原事实', { kind: 'memory', messageRole: null })]);
  const otherScope = { ...scope, characterId: 'sweetheart' as const, turnId: 'second', generation: 2 };
  const second = input([source('second:user', '另一问题', { scope: otherScope }), source('second-memory', '另一事实', { scope: otherScope, kind: 'memory', messageRole: null })]);
  const gates: ((r: Response) => void)[] = [], requests: any[] = [];
  const transport = new ProviderTransport((_url, init) => new Promise<Response>(resolve => { requests.push(JSON.parse(String(init?.body))); gates.push(resolve); }));
  const provider = new QwenMemoryTurnProvider(config, transport, 'quoted-v2'), control = new AbortController();
  const pending = provider.plan(first, control.signal), rejected = assert.rejects(pending, { name: 'AbortError' }), accepted = provider.plan(second, signal());
  await new Promise(resolve => setImmediate(resolve)); assert.equal(gates.length, 2);
  (first.sources[2] as { text: string }).text = '外部已改变'; control.abort();
  const result = plan({ changes: [change({ type: 'update', id: 'm0', expectedVersion: 1, text: '完整新事实', sourceIds: ['s0'] })] });
  for (const gate of gates) gate(Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }] }));
  await rejected; const out = await accepted; assert.deepEqual(out.scope, otherScope); assert.equal((out.changes[0]!.operation as { id: string }).id, 'second-memory');
  assert.equal(JSON.stringify(requests[0]).includes('外部已改变'), false); assert.equal(JSON.stringify(requests[1]).includes('原事实'), false);
});
