import test from 'node:test';
import assert from 'node:assert/strict';
import type { TurnScope } from '../../contracts/index.js';
import type { MemorySource, MemoryTurnInput } from '../../contracts/memory-lifecycle.js';
import { QwenDialogueProvider } from '../../providers/qwen-dialogue.js';
import { QwenMemoryTurnProvider, QwenSummaryProvider } from '../../providers/qwen-memory-lifecycle.js';
import { ProviderTransport } from '../../providers/transport.js';

const scope: TurnScope = { characterId: 'friend', sessionId: 'source-package', turnId: 'current', generation: 4 };
const signal = () => new AbortController().signal;
function source(id: string, text: string, patch: Partial<MemorySource> = {}): MemorySource {
  return { scope, id, text, version: 2, kind: 'transcript', messageRole: 'user', createdAt: '2026-09-01T00:00:00Z', sourceVersions: [], evidenceEligible: true, ...patch };
}
function input(sources = [source('current:user', '忘记猫的名字。我周日跑步。'), source('old:user', '猫叫团子。周五练琴🐱。我不喝咖啡。')]): MemoryTurnInput {
  return { scope, currentMessageId: sources[0]!.id, sources,
    messages: sources.filter(s => s.kind === 'transcript').map(s => ({ characterId: scope.characterId, id: s.id, text: s.text, role: s.messageRole!, createdAt: s.createdAt })),
    relevantMemories: sources.filter(s => s.kind === 'memory').map(s => ({ characterId: scope.characterId, id: s.id, text: s.text, version: s.version, sourceIds: (s.sourceVersions ?? []).map(ref => ref.id) })) };
}
const plan = (patch: Record<string, unknown> = {}) => ({ request: 'none', changes: [], suppressSources: [], retainSources: [], clarification: null, reason: '当前有效证据', ...patch });
const ref = (id: string) => ({ id, version: 2 });
const retain = (id: string, fragmentId = 'f0', start = 0, end = 1, supportSourceIds: string[] = []) => ({ source: ref(id), fragmentId, start, end, supportSourceIds });
const change = (operation: unknown) => ({ reason: '当前事实依据', operation });
const add = (sourceIds: string[] = ['s0']) => change({ type: 'add', id: 'n0', text: '有依据的新事实', sourceIds });
function harness(response: unknown | ((payload: any) => unknown), after?: () => void) {
  const requests: any[] = [];
  const transport = new ProviderTransport(async (_url, init) => {
    const request = JSON.parse(String(init?.body)); requests.push(request);
    const answer = typeof response === 'function' ? response(JSON.parse(request.messages.at(-1).content)) : response;
    after?.();
    return Response.json({ choices: [{ message: { content: JSON.stringify(answer) }, finish_reason: 'stop' }] });
  });
  const config = { endpoint: 'https://controlled.invalid/chat/completions', model: 'qwen-plus-2025-12-01', apiKey: () => 'test-only', authorizer: { async authorize() { return { async settle() {} }; } } };
  return { turn: new QwenMemoryTurnProvider(config, transport), summary: new QwenSummaryProvider(config, transport), dialogue: new QwenDialogueProvider(config, transport), requests };
}

test('single current object and evidence table retain exact source fields without repeating bodies or full identities', async () => {
  const data = input(), run = harness(plan()); await run.turn.plan(data, signal());
  const payload = JSON.parse(run.requests[0].messages[1].content), wire = [...payload.evidence, payload.currentMessage];
  assert.deepEqual(Object.keys(payload), ['evidence', 'currentMessage']); assert.equal(payload.currentMessage.text, data.sources[0]!.text);
  assert.equal(wire.length, data.sources.length);
  for (const s of data.sources) {
    const row = wire.find((r: any) => r.text === s.text); assert(row);
    for (const k of ['version', 'kind', 'messageRole', 'createdAt', 'sourceVersions', 'evidenceEligible'] as const) assert.deepEqual(row[k], s[k]);
    assert.equal(JSON.stringify(payload).includes(s.id), false); assert.equal('scope' in row, false);
  }
  assert.equal(run.requests[0].messages.length, 2); // historical commands never become conversational API messages
  assert.equal('max_tokens' in run.requests[0], false);
});

test('existing IDs round-trip, and actual IDs resembling aliases never collide with wire aliases', async () => {
  const data = input([source('s0', '当前话语'), source('old', '旧话语')]);
  const run = harness((payload: any) => plan({ changes: [add([payload.currentMessage.id])] }));
  const result = await run.turn.plan(data, signal()), op = result.changes[0]!.operation;
  assert.equal(op.type, 'add'); if (op.type === 'add') assert.deepEqual(op.sourceIds, ['s0']);
  assert.notEqual(JSON.parse(run.requests[0].messages[1].content).currentMessage.id, 's0');
  for (const id of ['current:user', 'old:user', 's99', 'u0', 'f0']) await assert.rejects(harness(plan({ changes: [add([id])] })).turn.plan(input(), signal()));
});

test('unknown, mixed, stale or duplicate references and fragment-as-target are refused without retry', async () => {
  const responses = [plan({ suppressSources: [{ id: 's1', version: 1 }] }), plan({ changes: [add(['s0', 'current:user'])] }),
    plan({ changes: [add(['s0', 's0'])] }), plan({ changes: [change({ type: 'update', id: 's0', expectedVersion: 2, text: 'x', sourceIds: ['s1'] })] }),
    plan({ suppressSources: [ref('s1')], retainSources: [retain('s1')], changes: [change({ type: 'soft_delete', id: 'f0', expectedVersion: 1 })] })];
  for (const response of responses) { const run = harness(response); await assert.rejects(run.turn.plan(input(), signal())); assert.equal(run.requests.length, 1); }
});

test('mixed current and historical raw keep exact contiguous fragments and pass f aliases to storage', async () => {
  const response = plan({ request: 'forget', suppressSources: [ref('s0'), ref('s1')], retainSources: [retain('s0', 'f0', 7, 13), retain('s1', 'f1', 5, 11)], changes: [add(['f1'])] });
  const result = await harness(response).turn.plan(input(), signal());
  assert.deepEqual(result.suppressSources, [ref('current:user'), ref('old:user')]);
  assert.deepEqual(result.retainSources?.map(r => r.fragmentId), ['f0', 'f1']);
  const parent = input().sources[1]!;
  assert.equal(Array.from(parent.text).slice(result.retainSources![1]!.start, result.retainSources![1]!.end).join(''), '周五练琴🐱。');
  const op = result.changes[0]!.operation; if (op.type === 'add') assert.deepEqual(op.sourceIds, ['f1']); else assert.fail('expected add');
});

test('current forget must be explicit; current correction suppression must retain its new evidence', async () => {
  await assert.rejects(harness(plan({ request: 'forget', suppressSources: [ref('s1')] })).turn.plan(input(), signal()), /explicitly handle/);
  await assert.rejects(harness(plan({ request: 'correction', suppressSources: [ref('s0')] })).turn.plan(input(), signal()), /retain current evidence/);
  const response = plan({ request: 'correction', suppressSources: [ref('s0')], retainSources: [retain('s0', 'f0', 7, 13)], changes: [add(['f0'])] });
  const parsed = await harness(response).turn.plan(input(), signal()); assert.equal(parsed.request, 'correction');
});

test('fragment structure rejects extra keys, missing fields, bad ranges, alias collisions and cross-fragment overlap', async () => {
  const valid = retain('s1');
  const rows: unknown[][] = [
    [{ ...valid, text: '重写原文' }], [{ source: ref('s1'), fragmentId: 'f0', start: 0, end: 1 }],
    ...[{ start: -1 }, { start: 1.5 }, { start: '0' }, { end: 0 }, { end: 100 }, { fragmentId: 's3' }, { fragmentId: 'f01' }, { fragmentId: 'f-1' }].map(patch => [{ ...valid, ...patch }]),
    [valid, { ...valid, fragmentId: 'f1' }], [valid, { ...valid, start: 1, end: 2 }],
  ];
  for (const retainSources of rows) await assert.rejects(harness(plan({ suppressSources: [ref('s1')], retainSources })).turn.plan(input(), signal()));
  await assert.rejects(harness(plan({ retainSources: [valid] })).turn.plan(input(), signal()), /explicitly suppressed/);
  await assert.rejects(harness(plan({ suppressSources: [ref('s1')], retainSources: [valid], clarification: '哪件事？' })).turn.plan(input(), signal()), /Clarification/);
  await assert.rejects(harness(plan({ suppressSources: [ref('s1')], retainSources: [valid], changes: [change({ type: 'add', id: 'f0', text: '事实', sourceIds: ['f0'] })] })).turn.plan(input(), signal()));
});

test('code point ranges preserve emoji, combining characters, negation and repeated occurrences without normalization', async () => {
  const raw = '我不喝咖啡。🐱e\u0301；我不喝咖啡。', data = input([source('current:user', '只忘记表情符号'), source('old:user', raw)]);
  const end = Array.from(raw).length;
  const retained = [retain('s1', 'f0', 0, 6), retain('s1', 'f1', 7, end)];
  const parsed = await harness(plan({ suppressSources: [ref('s1')], retainSources: retained })).turn.plan(data, signal());
  const texts = parsed.retainSources!.map(r => Array.from(raw).slice(r.start, r.end).join(''));
  assert.deepEqual(texts, ['我不喝咖啡。', 'e\u0301；我不喝咖啡。']);
});

function derivedInput(): MemoryTurnInput {
  return input([...input().sources, source('summary', '周五练琴🐱。', { kind: 'summary', messageRole: null, sourceVersions: [ref('old:user')] }),
    source('assistant', '练琴这件事。', { messageRole: 'assistant', sourceVersions: [ref('old:user')] })]);
}

test('summary and assistant fragments require a surviving support DAG and round-trip all existing support IDs', async () => {
  const response = plan({ suppressSources: [ref('s1'), ref('s2'), ref('s3')], retainSources: [retain('s1', 'f0', 5, 11), retain('s2', 'f1', 0, 6, ['f0']), retain('s3', 'f2', 0, 2, ['f1', 's0'])], changes: [add(['f2'])] });
  const result = await harness(response).turn.plan(derivedInput(), signal());
  assert.deepEqual(result.retainSources![2]!.supportSourceIds, ['f1', 'current:user']);
  const bad = [
    [retain('s2', 'f0')], [retain('s2', 'f0', 0, 1, ['f0'])],
    [retain('s2', 'f0', 0, 1, ['f1']), retain('s3', 'f1', 0, 1, ['f0'])],
    [retain('s2', 'f0', 0, 1, ['s1'])], [retain('s2', 'f0', 0, 1, ['f99'])],
    [retain('s1', 'f0', 0, 1, ['s0'])],
  ];
  for (const retainSources of bad) await assert.rejects(harness(plan({ suppressSources: [ref('s1'), ref('s2'), ref('s3')], retainSources })).turn.plan(derivedInput(), signal()));
});

test('support cannot point to changed memory or a descendant whose dependency is changing', async () => {
  const data = input([...derivedInput().sources, source('memory', '记忆', { kind: 'memory', messageRole: null }), source('derived', '派生', { kind: 'summary', messageRole: null, sourceVersions: [ref('memory')] })]);
  for (const support of ['s4', 's5']) await assert.rejects(harness(plan({ suppressSources: [ref('s2')], retainSources: [retain('s2', 'f0', 0, 1, [support])], changes: [change({ type: 'update', id: 's4', expectedVersion: 2, text: '变化', sourceIds: ['s0'] })] })).turn.plan(data, signal()), /support will change/);
});

test('only-summary unavailable registered ancestry is a candidate, not proof of natural expiry', async () => {
  const summary = source('summary', '旧原文已到期的摘要', { kind: 'summary', messageRole: null, sourceVersions: [ref('expired-raw')] });
  const data = input([input().sources[0]!, summary]);
  const response = plan({ suppressSources: [ref('s1')], retainSources: [retain('s1')] });
  assert.equal((await harness(response).turn.plan(data, signal())).retainSources?.length, 1);
  for (const patch of [{ sourceVersions: [] }, { kind: 'transcript', messageRole: 'assistant' }] as const) {
    const bad = input([data.sources[0]!, { ...summary, ...patch }]); await assert.rejects(harness(response).turn.plan(bad, signal()));
  }
  const run = harness(plan({ changes: [add(['u2'])] })); await assert.rejects(run.turn.plan(data, signal()), /Unknown wire source/);
});

test('display-only assistants cannot support extraction, retained facts or summaries', async () => {
  const assistant = source('unbound', '我猜你养猫', { messageRole: 'assistant', evidenceEligible: false });
  const data = input([input().sources[0]!, assistant]);
  for (const response of [plan({ changes: [add(['s1'])] }), plan({ suppressSources: [ref('s1')], retainSources: [retain('s1', 'f0', 0, 1, ['s0'])] })]) await assert.rejects(harness(response).turn.plan(data, signal()));
  const run = harness({}); await assert.rejects(run.summary.summarize(data, signal()), /Display-only/); assert.equal(run.requests.length, 0);
});

test('lineage and eligibility metadata are validated before any authorization, including unbound assistant promotion', async () => {
  for (const patch of [{ sourceVersions: [ref('x'), ref('x')] }, { sourceVersions: [{ id: 'x', version: '2' }] }, { evidenceEligible: 'true' }, { evidenceEligible: null }, { sourceVersions: null }, { messageRole: 'assistant' }, { evidenceEligible: false }]) {
    const data = input([source('current:user', 'current'), { ...source('old', 'old'), ...patch } as MemorySource]);
    const run = harness(plan()); await assert.rejects(run.turn.plan(data, signal())); assert.equal(run.requests.length, 0);
  }
});

test('exact duplicate adds are rejected; existing duplicates can still merge and facts can update naturally', async () => {
  const data = input([...input().sources, source('m1', '已有同一事实', { kind: 'memory', messageRole: null }), source('m2', '已有同一事实', { kind: 'memory', messageRole: null })]);
  await assert.rejects(harness(plan({ changes: [change({ type: 'add', id: 'n0', text: '已有同一事实', sourceIds: ['s1'] })] })).turn.plan(data, signal()), /Identical memory/);
  for (const op of [{ type: 'merge', targets: [{ id: 's2', expectedVersion: 2 }, { id: 's3', expectedVersion: 2 }], replacement: { id: 'n0', text: '已有同一事实', sourceIds: ['s2', 's3'] } }, { type: 'update', id: 's2', expectedVersion: 2, text: '事实已经变化', sourceIds: ['s0'] }]) {
    const result = await harness(plan({ changes: [change(op)] })).turn.plan(data, signal()); assert.equal(result.request, 'none'); assert.equal(result.changes.length, 1);
  }
});

test('simultaneous calls keep alias maps and returned scopes independent, including late cancellation', async () => {
  const gates: { resolve: (value: Response) => void; body: any }[] = [];
  const transport = new ProviderTransport((_url, init) => new Promise<Response>(resolve => gates.push({ resolve, body: JSON.parse(String(init?.body)) })));
  const config = { endpoint: 'https://controlled.invalid/chat/completions', model: 'test', apiKey: () => 'test-only', authorizer: { async authorize() { return { async settle() {} }; } } };
  const provider = new QwenMemoryTurnProvider(config, transport), one = input();
  const otherScope = { ...scope, characterId: 'sweetheart' as const, sessionId: 'other', turnId: 'other' };
  const two = input([source('other:user', '另一个角色')]);
  const other: MemoryTurnInput = { ...two, scope: otherScope, sources: two.sources.map(s => ({ ...s, scope: otherScope })), messages: two.messages.map(m => ({ ...m, characterId: otherScope.characterId })) };
  const controller = new AbortController(), first = provider.plan(one, controller.signal), second = provider.plan(other, signal());
  const caught = assert.rejects(first, { name: 'AbortError' });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(gates.length, 2);
  controller.abort();
  const answer = Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(plan({ changes: [add(['s0'])] })) } }] });
  const lateAnswer = answer.clone(); gates[1]!.resolve(answer); const result = await second; gates[0]!.resolve(lateAnswer); await caught;
  assert.deepEqual(result.scope, otherScope); const op = result.changes[0]!.operation; if (op.type === 'add') assert.deepEqual(op.sourceIds, ['other:user']);
});

test('diagnostic code never reaches dialogue and grounding instructions do not count as verified naturalness', async () => {
  const run = harness({ text: '暂时未完成。', expression: { emotion: 'neutral', intensity: 0, delivery: 'natural', gesture: null } });
  await run.dialogue.reply({ scope, text: '忘记这件事', context: { scope, characterPrompt: '朋友', recent: [], summary: '', memories: [], perception: null, inputTokenBudget: 32768 }, memoryOutcome: { scope, request: 'forget', status: 'rejected', results: [], affectedIds: [], retrievalInvalidated: false, clarification: null, rejectionCode: 'unresolved_memory_suppression' } }, signal());
  const payload = JSON.stringify(run.requests[0]); assert.equal(payload.includes('unresolved_memory_suppression'), false);
  assert.match(payload, /角色设定不是事件证据/); assert.match(payload, /不能编造/);
});
