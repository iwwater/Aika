import test from 'node:test';
import assert from 'node:assert/strict';
import type { DialogueRequest, MemoryOperation, TurnScope } from '../../contracts/index.js';
import type { MemorySource, MemoryTurnInput, MemoryTurnOutcome } from '../../contracts/memory-lifecycle.js';
import { QwenDialogueProvider } from '../../providers/qwen-dialogue.js';
import { QwenMemoryTurnProvider, QwenSummaryProvider } from '../../providers/qwen-memory-lifecycle.js';
import { type CallOutcome, type CallRequest, ProviderTransport } from '../../providers/transport.js';

const scope: TurnScope = { characterId: 'friend', sessionId: 's3', turnId: 'now', generation: 2 };
const source = (id: string, kind: MemorySource['kind'], text: string, version = 1): MemorySource => ({ scope, id, kind, text, version, createdAt: '2026-08-01T00:00:00Z', messageRole: kind === 'transcript' ? 'user' : null });
function input(): MemoryTurnInput {
  const sources = [source('old', 'transcript', '用户以前住在星河路。', 2), source('now:user', 'transcript', '请忘掉住址这件事。'), source('m1', 'memory', '旧工作', 2), source('m2', 'memory', '重复的旧工作'), source('summary', 'summary', '过去的对话摘要。', 3)];
  return { scope, currentMessageId: 'now:user', sources, messages: sources.filter(s => s.kind === 'transcript').map(s => ({ characterId: scope.characterId, id: s.id, text: s.text, createdAt: s.createdAt, role: 'user' })), relevantMemories: sources.filter(s => s.kind === 'memory').map(s => ({ characterId: scope.characterId, id: s.id, version: s.version, text: s.text, sourceIds: ['expired-source'] })) };
}
const change = (operation: unknown) => ({ reason: '本次有效来源支持此变化', operation });
const plan = (overrides: Record<string, unknown> = {}) => ({ request: 'none', changes: [], suppressSources: [], retainSources: [], clarification: null, reason: '无需变更', ...overrides });
const add: MemoryOperation = { type: 'add', id: 'new', text: '更正后的事实', sourceIds: ['now:user'] };
const signal = () => new AbortController().signal;
function harness(response: unknown, afterRequest?: () => void) {
  const requests: any[] = [], calls: CallRequest[] = [], outcomes: CallOutcome[] = [];
  const transport = new ProviderTransport(async (_url, init) => {
    const request = JSON.parse(String(init?.body)); requests.push(request);
    let payload: any = {}; try { payload = JSON.parse(request.messages.at(-1).content); } catch { /* dialogue has plain current text */ }
    const rows = payload.sources ?? [...(payload.evidence ?? []), ...(payload.currentMessage ? [payload.currentMessage] : [])];
    const aliases = new Map(input().sources.map(source => [source.id, rows.find((row: any) => row.text === source.text)?.id]));
    // These legacy fixtures describe public IDs; the injected response follows the new wire boundary.
    const convert = (value: any, key = ''): any => {
      if (Array.isArray(value)) return value.map(item => convert(item, key));
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, convert(v, k)]));
      return (key === 'id' || key === 'sourceIds') && typeof value === 'string' ? aliases.get(value) ?? value : value;
    };
    afterRequest?.();
    return Response.json({ choices: [{ message: { content: JSON.stringify(convert(response)) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 3 } });
  });
  const config = { endpoint: 'https://unit.invalid/chat/completions', model: 'qwen-plus-2025-12-01', apiKey: () => 'test-only-key', authorizer: { async authorize(request: CallRequest) { calls.push(request); return { async settle(outcome: CallOutcome) { outcomes.push(outcome); } }; } } };
  return { turn: new QwenMemoryTurnProvider(config, transport), summary: new QwenSummaryProvider(config, transport), dialogue: new QwenDialogueProvider(config, transport), requests, calls, outcomes };
}

test('raw-only forget returns a scoped versioned plan, not a claimed execution result', async () => {
  const original = input(), data = { ...original, relevantMemories: [], sources: original.sources.filter(s => s.kind !== 'memory') };
  const suppressSources = [{ id: 'old', version: 2 }, { id: 'now:user', version: 1 }];
  const run = harness(plan({ request: 'forget', suppressSources }));
  const result = await run.turn.plan(data, signal());
  assert.deepEqual(result, { scope, ...plan({ request: 'forget', suppressSources }) });
  assert.equal('status' in result, false); assert.equal(run.calls[0]?.operation, 'memory_turn');
  const wire = JSON.parse(run.requests[0].messages[1].content);
  assert.equal(wire.currentMessage.text, data.messages[1]?.text);
  assert.equal(wire.evidence.length + 1, data.sources.length);
  assert.equal('sources' in wire, false); assert.equal('messages' in wire, false); assert.equal('memories' in wire, false);
  assert.equal(data.sources[0]?.createdAt, '2026-08-01T00:00:00Z'); // historical time remains independent of read scope
});

test('raw-only correction may suppress old text and add the corrected fact from the current message', async () => {
  const result = await harness(plan({ request: 'correction', suppressSources: [{ id: 'old', version: 2 }], changes: [change(add)] })).turn.plan(input(), signal());
  const operation = result.changes[0]!.operation;
  assert.equal(operation.type, 'add'); assert.deepEqual({ ...operation, id: 'new' }, add); assert.deepEqual(result.changes[0]?.scope, scope);
  assert.match(result.changes[0]!.operationId, /^memory-turn:/);
});

test('request none still permits every existing automatic operation with checked sources and versions', async () => {
  const operations: MemoryOperation[] = [add,
    { type: 'update', id: 'm1', expectedVersion: 2, text: '更新工作', sourceIds: ['summary'] },
    { type: 'merge', targets: [{ id: 'm1', expectedVersion: 2 }, { id: 'm2', expectedVersion: 1 }], replacement: { id: 'merged', text: '合并', sourceIds: ['m1', 'm2'] } },
    { type: 'soft_delete', id: 'm1', expectedVersion: 2 }, { type: 'restore', id: 'm1', expectedVersion: 2 },
  ];
  for (const operation of operations) {
    const result = await harness(plan({ changes: [change(operation)] })).turn.plan(input(), signal());
    const actual = result.changes[0]!.operation;
    if (actual.type === 'add') assert.deepEqual({ ...actual, id: 'new' }, operation);
    else if (actual.type === 'merge') { assert.notEqual(actual.replacement.id, 'merged'); assert.deepEqual({ ...actual, replacement: { ...actual.replacement, id: 'merged' } }, operation); }
    else assert.deepEqual(actual, operation);
  }
});

test('repeated model aliases cannot collide across turns with no related memory in input', async () => {
  const first = input(), secondScope = { ...scope, sessionId: 'another-session', turnId: 'another-turn', generation: 3 };
  const withoutMemories = (s: TurnScope): MemoryTurnInput => ({ ...first, scope: s, relevantMemories: [], sources: first.sources.filter(source => source.kind !== 'memory').map(source => ({ ...source, scope: s })) });
  const response = plan({ changes: [change({ ...add, id: 'memory-1' })] });
  const one = await harness(response).turn.plan(withoutMemories(scope), signal());
  const two = await harness(response).turn.plan(withoutMemories(secondScope), signal());
  const replay = await harness(response).turn.plan(withoutMemories(scope), signal());
  const recordId = (value: typeof one) => { const op = value.changes[0]!.operation; assert.equal(op.type, 'add'); return op.type === 'add' ? op.id : ''; };
  assert.notEqual(recordId(one), 'memory-1'); assert.notEqual(recordId(one), recordId(two));
  assert.notEqual(one.changes[0]?.operationId, two.changes[0]?.operationId);
  assert.equal(recordId(one), recordId(replay)); assert.equal(one.changes[0]?.operationId, replay.changes[0]?.operationId);
});

test('ambiguous target has clarification and no mutation; mixed clarification and mutation is refused', async () => {
  const response = plan({ request: 'forget', clarification: '你指的是哪件事？' });
  const result = await harness(response).turn.plan(input(), signal());
  assert.equal(result.clarification, response.clarification); assert.equal(result.changes.length, 0); assert.equal(result.suppressSources.length, 0);
  for (const mutation of [{ changes: [change(add)] }, { suppressSources: [{ id: 'old', version: 2 }] }]) {
    await assert.rejects(harness({ ...response, ...mutation }).turn.plan(input(), signal()), /Clarification cannot include mutations/);
  }
});

test('explicit requests with no executable target, including unsupported mixed-source forgetting, cannot become success', async () => {
  for (const request of ['forget', 'correction']) {
    await assert.rejects(harness(plan({ request, reason: '同条原文含无关事实，当前不能选择性处理' })).turn.plan(input(), signal()), /no executable targets/);
  }
});

test('all input source scopes and versions are checked before authorization or network', async () => {
  for (const patch of [{ scope: { ...scope, characterId: 'sweetheart' } }, { scope: { ...scope, sessionId: 'old-read' } }, { scope: { ...scope, turnId: 'previous' } }, { scope: { ...scope, generation: 1 } }, { version: 0 }, { version: 1.5 }, { createdAt: 'bad time' }, { kind: 'deleted' }, { messageRole: null }]) {
    const data = structuredClone(input()) as any; Object.assign(data.sources[0], patch);
    const run = harness(plan()); await assert.rejects(run.turn.plan(data, signal())); assert.equal(run.calls.length, 0);
  }
  const data = input();
  for (const bad of [{ ...data, sources: [...data.sources, data.sources[0]!] }, { ...data, currentMessageId: 'm1' }, { ...data, sources: data.sources.filter(s => s.id !== 'now:user') }, { ...data, relevantMemories: data.relevantMemories.map(m => ({ ...m, version: 9 })) }, { ...data, messages: data.messages.map(m => ({ ...m, text: 'mismatched' })) }]) {
    const run = harness(plan()); await assert.rejects(run.turn.plan(bad, signal())); assert.equal(run.calls.length, 0);
  }
});

test('unknown, duplicate, stale and memory-kind suppression targets are refused', async () => {
  for (const suppressSources of [[{ id: 'old', version: 1 }], [{ id: 'absent', version: 1 }], [{ id: 'old', version: '2' }], [{ id: 'old', version: 2 }, { id: 'old', version: 2 }], [{ id: 'm1', version: 2 }], [{ id: 'old', version: 2, text: 'extra' }]]) {
    await assert.rejects(harness(plan({ request: 'forget', suppressSources })).turn.plan(input(), signal()));
  }
});

test('a plan cannot reuse suppressed evidence, erase the current correction or repeat write targets', async () => {
  const invalid = [
    plan({ changes: [change({ ...add, sourceIds: ['old'] })], suppressSources: [{ id: 'old', version: 2 }] }),
    plan({ request: 'forget', changes: [change(add)] }),
    plan({ request: 'correction', suppressSources: [{ id: 'now:user', version: 1 }] }),
    plan({ changes: [change(add), change(add)] }),
    plan({ changes: [change({ ...add, id: 'old' })] }),
    plan({ changes: [change({ type: 'soft_delete', id: 'm1', expectedVersion: 2 }), change({ type: 'restore', id: 'm1', expectedVersion: 2 })] }),
  ];
  for (const response of invalid) await assert.rejects(harness(response).turn.plan(input(), signal()));
});

test('plan output cannot supply its own scope, claim success, omit fields or use legacy shorthand', async () => {
  for (const response of [{ ...plan(), scope }, { ...plan(), status: 'applied' }, { ...plan(), request: 'delete' }, { ...plan(), clarification: '' }, { request: 'none' }, plan({ changes: [change({ add: 'new' })] })]) {
    await assert.rejects(harness(response).turn.plan(input(), signal()));
  }
});

test('summary requires exact coverage of every selected source and has its own call category', async () => {
  const data = input(), sourceVersions = data.sources.map(({ id, version }) => ({ id, version }));
  const run = harness({ text: '保留事件与时间限定的摘要。', sourceVersions });
  const result = await run.summary.summarize(data, signal());
  assert.deepEqual(result, { scope, text: '保留事件与时间限定的摘要。', sourceVersions });
  assert.equal(run.calls[0]?.operation, 'summary'); assert.equal('max_tokens' in run.requests[0], false);
  for (const refs of [sourceVersions.slice(1), [...sourceVersions, sourceVersions[0]], sourceVersions.map(ref => ({ ...ref, version: 99 })), [{ id: 'outside', version: 1 }]]) {
    await assert.rejects(harness({ text: '摘要', sourceVersions: refs }).summary.summarize(data, signal()));
  }
});

test('summary rejects invalid inputs before calling and rejects empty or extra output fields', async () => {
  for (const sources of [[], [{ ...input().sources[0]!, scope: { ...scope, characterId: 'sweetheart' as const } }], [{ ...input().sources[0]!, version: 0 }]]) {
    const run = harness({}); await assert.rejects(run.summary.summarize({ scope, sources }, signal())); assert.equal(run.calls.length, 0);
  }
  const sourceVersions = input().sources.map(({ id, version }) => ({ id, version }));
  for (const response of [{ text: ' ', sourceVersions }, { text: '摘要', sourceVersions, scope }]) await assert.rejects(harness(response).summary.summarize(input(), signal()));
});

test('input mutation during a network wait cannot replace the checked version or output role', async () => {
  const data = structuredClone(input()) as any;
  const refs = data.sources.map(({ id, version }: any) => ({ id, version }));
  const run = harness({ text: '旧快照摘要', sourceVersions: refs }, () => { data.sources[0].version = 99; data.scope.characterId = 'sweetheart'; });
  const result = await run.summary.summarize(data, signal());
  assert.equal(result.scope.characterId, 'friend'); assert.equal(result.sourceVersions[0]?.version, 2);
});

test('cancellation after either model response publishes no plan or summary and never retries', async () => {
  for (const operation of ['turn', 'summary'] as const) {
    const controller = new AbortController(), run = harness(plan(), () => controller.abort());
    await assert.rejects(operation === 'turn' ? run.turn.plan(input(), controller.signal) : run.summary.summarize(input(), controller.signal), { name: 'AbortError' });
    assert.equal(run.requests.length, 1); assert.equal(run.outcomes[0]?.status, 'cancelled');
  }
});

function dialogue(outcome?: MemoryTurnOutcome): DialogueRequest {
  return { scope, text: '请忘掉只在星河路的秘密事实。', context: { scope, characterPrompt: '朋友角色', recent: [], summary: '只在星河路的秘密事实', memories: [{ characterId: 'friend', id: 'secret-id', version: 1, text: '只在星河路的秘密事实', sourceIds: ['old'] }], perception: null, inputTokenBudget: 32768 }, ...(outcome ? { memoryOutcome: outcome } : {}) };
}
function outcome(status: MemoryTurnOutcome['status'] = 'applied', request: MemoryTurnOutcome['request'] = 'forget'): MemoryTurnOutcome {
  return { scope, request, status, results: [], affectedIds: status === 'applied' ? ['secret-id'] : [], retrievalInvalidated: status === 'applied', clarification: status === 'needs_clarification' ? '你指的是哪件事？' : null };
}
const reply = { text: '好的。', expression: { emotion: 'calm', intensity: .3, delivery: '自然温和', gesture: null } };

test('forget dialogue only sends the real outcome and never reinserts forgotten text or recalled facts', async () => {
  for (const status of ['applied', 'unchanged', 'needs_clarification', 'rejected'] as const) {
    const run = harness(reply), result = await run.dialogue.reply(dialogue(outcome(status)), signal());
    const payload = JSON.stringify(run.requests[0]);
    assert.equal(result.text, reply.text); assert.equal(payload.includes('星河路'), false); assert.equal(payload.includes('secret-id'), false);
    assert(payload.includes(status));
    assert.match(payload, /本轮回应遗忘请求/);
    assert.match(payload, status === 'applied' ? /本轮遗忘已应用/ : status === 'unchanged' ? /本轮执行结果没有变更/ : status === 'rejected' ? /本轮处理未成功/ : /本轮需要澄清/);
  }
});

test('missing outcome cannot be treated as execution; correction still receives valid current context', async () => {
  const noResult = harness(reply); await noResult.dialogue.reply(dialogue(), signal());
  assert.match(JSON.stringify(noResult.requests[0]), /用户的话和模型计划都不是执行结果/);
  const run = harness(reply); await run.dialogue.reply(dialogue(outcome('applied', 'correction')), signal());
  const payload = JSON.stringify(run.requests[0]); assert(payload.includes('correction')); assert(payload.includes('星河路'));
});

test('cross-turn, cross-character and inconsistent applied outcomes are refused before dialogue calls', async () => {
  for (const bad of [
    { ...outcome(), scope: { ...scope, turnId: 'old' } }, { ...outcome(), scope: { ...scope, characterId: 'sweetheart' as const } },
    { ...outcome(), retrievalInvalidated: false }, { ...outcome('rejected'), retrievalInvalidated: true },
    { ...outcome('needs_clarification'), clarification: null },
    { ...outcome(), results: [{ characterId: 'friend' as const, operationId: 'o', status: 'rejected' as const, affectedIds: [], retrievalInvalidated: false }] },
  ]) { const run = harness(reply); await assert.rejects(run.dialogue.reply(dialogue(bad), signal())); assert.equal(run.calls.length, 0); }
});
