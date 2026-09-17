import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { MemoryTurnInput } from '../../contracts/memory-lifecycle.js';
import { DeepSeekMemoryTurnProvider } from '../../providers/deepseek-memory-lifecycle.js';
import { QwenMemoryTurnProvider, QwenSummaryProvider } from '../../providers/qwen-memory-lifecycle.js';
import { type CallOutcome, type CallRequest, type EndpointConfig, denyPaidCalls, ProviderTransport } from '../../providers/transport.js';
import { boundedOriginals } from './fixtures/bounded-prompt-originals.js';
import { originalSourceCases } from './fixtures/quoted-original-sources.js';
import { change, input, plan, ref, retained, scope, signal, source } from './quoted-helpers.js';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const rawOnly = boundedOriginals.find(item => item.name === 'mixed-raw-only-forget')!;
const validForget = () => plan({ request: 'forget', suppressSources: [ref('s0'), ref('s1')], retainSources: [retained('我养的猫叫团子。')] });
function completion(value: unknown, finishReason: unknown = 'stop'): Response {
  return Response.json({ choices: [{ finish_reason: finishReason, message: { content: typeof value === 'string' ? value : JSON.stringify(value) } }] });
}
function harness(reply: (body: any, init: RequestInit | undefined) => Response | Promise<Response> = () => completion(plan())) {
  const requests: { url: string; body: any; init: RequestInit | undefined }[] = [];
  const authorizations: CallRequest[] = [], outcomes: CallOutcome[] = [];
  // Every test injects this fetcher. The official URL is a body/routing assertion,
  // never a network destination; no environment or real credential is read.
  const config: EndpointConfig = {
    endpoint: 'https://api.deepseek.com/chat/completions', model: 'deepseek-v4-flash', apiKey: () => 'controlled-test-only',
    authorizer: { async authorize(request) { authorizations.push(structuredClone(request)); return { async settle(outcome) { outcomes.push(structuredClone(outcome)); } }; } },
  };
  const transport = new ProviderTransport(async (url, init) => {
    const body = JSON.parse(String(init?.body)); requests.push({ url: String(url), body, init });
    return reply(body, init);
  });
  return { provider: new DeepSeekMemoryTurnProvider(config, transport), config, transport, requests, authorizations, outcomes };
}

test('DeepSeek sends the frozen quoted input and registered non-thinking JSON request only', async () => {
  const h = harness(() => completion(validForget())), abortSignal = signal();
  await h.provider.plan(rawOnly.input, abortSignal);
  assert.equal(h.requests.length, 1);
  const { url, body, init } = h.requests[0]!;
  assert.equal(url, 'https://api.deepseek.com/chat/completions');
  assert.deepEqual(Object.keys(body).sort(), ['messages', 'model', 'response_format', 'stream', 'thinking']);
  assert.equal(body.model, 'deepseek-v4-flash');
  assert.equal(body.stream, false);
  assert.deepEqual(body.thinking, { type: 'disabled' });
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.equal(sha(body.messages[0].content), '69a69d32fb7183337f8597a89477275ec5320699d71ada53d168db29ee9e389f');
  assert.equal(Buffer.byteLength(body.messages[0].content), 10523);
  assert.deepEqual(body.messages.map((message: any) => message.role), ['system', 'user']);
  assert.deepEqual(JSON.parse(body.messages[1].content), rawOnly.originalData);
  assert.equal(init?.signal, abortSignal);
  assert.equal(init?.method, 'POST');
  assert.equal(init?.redirect, 'error');
  assert.deepEqual(h.authorizations, [{ scope: rawOnly.input.scope, operation: 'memory_turn', model: h.config.model, endpoint: h.config.endpoint }]);
  assert.equal(h.outcomes.length, 1);
});

test('DeepSeek and Qwen quoted requests differ only in the non-thinking field', async () => {
  const d = harness(() => completion(validForget())), q = harness(() => completion(validForget()));
  const deepseek = await d.provider.plan(rawOnly.input, signal());
  const qwen = await new QwenMemoryTurnProvider(q.config, q.transport, 'quoted-v2').plan(rawOnly.input, signal());
  const { thinking, ...deepseekBody } = d.requests[0]!.body;
  const { enable_thinking, ...qwenBody } = q.requests[0]!.body;
  assert.deepEqual(thinking, { type: 'disabled' }); assert.equal(enable_thinking, false);
  assert.deepEqual(deepseekBody, qwenBody);
  assert.deepEqual(deepseek, qwen);
});

test('Qwen default request still matches the frozen original numeric messages', async () => {
  const original = originalSourceCases.find(item => item.name === 'mixed-raw-only-forget')!;
  const h = harness();
  await new QwenMemoryTurnProvider(h.config, h.transport).plan(original.input, signal());
  const body = h.requests[0]!.body;
  assert.deepEqual(body.messages, original.numericMessages);
  assert.deepEqual(Object.keys(body).sort(), ['enable_thinking', 'messages', 'model', 'response_format', 'stream']);
  assert.equal(body.enable_thinking, false);
});

test('Qwen summary keeps numeric wire, non-thinking field and complete source coverage', async () => {
  const item = source('summary:raw', '用户喜欢猫');
  const h = harness(() => completion({ text: '用户喜欢猫', sourceVersions: [ref('s0')] }));
  const config = { ...h.config, endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', model: 'qwen-plus' };
  const result = await new QwenSummaryProvider(config, h.transport).summarize({ scope, sources: [item] }, signal());
  assert.deepEqual(result, { scope, text: '用户喜欢猫', sourceVersions: [ref(item.id)] });
  const body = h.requests[0]!.body;
  assert.deepEqual(Object.keys(body).sort(), ['enable_thinking', 'messages', 'model', 'response_format', 'stream']);
  assert.equal(body.enable_thinking, false);
  assert.equal(Buffer.byteLength(body.messages[0].content), 772);
  assert.deepEqual(JSON.parse(body.messages[1].content), { sources: [{ id: 's0', version: 1, kind: 'transcript', messageRole: 'user', text: item.text, createdAt: item.createdAt, evidenceEligible: true, sourceVersions: [] }] });
  assert.equal(h.authorizations[0]?.operation, 'summary');
});

test('DeepSeek valid raw-only plan restores original IDs and exact public code-point span', async () => {
  const h = harness(() => completion(validForget())), original = structuredClone(rawOnly.input);
  const result = await h.provider.plan(original, signal());
  assert.deepEqual(result, {
    scope: original.scope, request: 'forget', changes: [],
    suppressSources: [ref(original.currentMessageId), ref('mixed-user')],
    retainSources: [{ source: ref('mixed-user'), fragmentId: 'f0', start: 15, end: 23, supportSourceIds: [] }],
    clarification: null, reason: '独立受控候选',
  });
  assert.deepEqual(original, rawOnly.input);
});

for (const name of ['mixed-raw-only-forget', 'mixed-summary-only-forget', 'retire-recall']) {
  test(`DeepSeek rejects unchanged historical absent-memory aliases: ${name}`, async () => {
    const original = boundedOriginals.find(item => item.name === name)!;
    assert.equal(sha(original.originalModelText), original.originalModelTextSha256);
    const h = harness(() => completion(original.originalModelText));
    await assert.rejects(h.provider.plan(original.input, signal()), { message: 'Unknown wire source or wrong source kind' });
    assert.deepEqual(JSON.parse(h.requests[0]!.body.messages[1].content), original.originalData);
    assert.equal(h.requests.length, 1);
    assert.equal(h.authorizations.length, 1);
  });
}

for (const [name, answer, error] of [
  ['wrong quote', plan({ request: 'forget', suppressSources: [ref('s0'), ref('s1')], retainSources: [retained('这里不存在的引文')] }), 'Quote has no exact match'],
  ['transcript as memory target', plan({ changes: [change({ type: 'soft_delete', id: 's1', expectedVersion: 1 })] }), 'Unknown wire source or wrong source kind'],
  ['stale version', plan({ request: 'forget', suppressSources: [ref('s0'), ref('s1', 2)] }), 'Unknown, duplicate or stale source version'],
  ['clarification with mutations', plan({ request: 'forget', suppressSources: [ref('s0')], clarification: '你指哪件事？' }), 'Clarification cannot include mutations'],
] as const) {
  test(`DeepSeek preserves strict rejection for ${name} without retry`, async () => {
    const h = harness(() => completion(answer));
    await assert.rejects(h.provider.plan(rawOnly.input, signal()), { message: error });
    assert.equal(h.requests.length, 1); assert.equal(h.outcomes.length, 1);
  });
}

test('DeepSeek unauthorized request never reaches the injected network boundary', async () => {
  const h = harness(); let denied = 0;
  const config = { ...h.config, authorizer: { async authorize(request: CallRequest, abortSignal: AbortSignal) { denied++; return denyPaidCalls.authorize(request, abortSignal); } } };
  await assert.rejects(new DeepSeekMemoryTurnProvider(config, h.transport).plan(input(), signal()), /paid calls have not been authorized/);
  assert.equal(denied, 1); assert.equal(h.requests.length, 0); assert.equal(h.outcomes.length, 0);
});

for (const status of [401, 429, 500]) {
  test(`DeepSeek HTTP ${status} settles once and never retries`, async () => {
    const h = harness(() => new Response('body must not enter exception', { status, headers: { 'x-request-id': `controlled-${status}` } }));
    await assert.rejects(h.provider.plan(input(), signal()), { message: `Provider HTTP ${status}` });
    assert.equal(h.requests.length, 1); assert.equal(h.authorizations.length, 1);
    assert.deepEqual(h.outcomes, [{ status: 'failed', usage: null, requestId: `controlled-${status}` }]);
  });
}

test('DeepSeek network failure settles once and never retries', async () => {
  const h = harness(() => { throw new Error('controlled network failure'); });
  await assert.rejects(h.provider.plan(input(), signal()), /controlled network failure/);
  assert.equal(h.requests.length, 1); assert.equal(h.authorizations.length, 1);
  assert.deepEqual(h.outcomes, [{ status: 'failed', usage: null, requestId: null }]);
});

for (const reason of ['length', 'content_filter', null]) {
  test(`DeepSeek finish_reason ${String(reason)} rejects completed HTTP delivery without retry`, async () => {
    const h = harness(() => completion(plan(), reason));
    await assert.rejects(h.provider.plan(input(), signal()), { message: 'Model reply was not completed normally' });
    assert.equal(h.requests.length, 1); assert.equal(h.authorizations.length, 1);
    // Existing transport settlement records delivery, not subsequent plan acceptance.
    assert.deepEqual(h.outcomes, [{ status: 'success', usage: null, requestId: null }]);
  });
}

test('DeepSeek empty JSON-mode content fails closed without another generation', async () => {
  const h = harness(() => completion(''));
  await assert.rejects(h.provider.plan(input(), signal()), { message: 'Model did not return valid structured data' });
  assert.equal(h.requests.length, 1); assert.equal(h.authorizations.length, 1);
});

test('DeepSeek cancelled before planning requests no permit or network', async () => {
  const h = harness(), controller = new AbortController(); controller.abort();
  await assert.rejects(h.provider.plan(input(), controller.signal), { name: 'AbortError' });
  assert.equal(h.requests.length, 0); assert.equal(h.authorizations.length, 0);
});

test('DeepSeek late cancelled response cannot contaminate another role on the same provider', async () => {
  let release!: (response: Response) => void, started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const late = new Promise<Response>(resolve => { release = resolve; });
  let count = 0;
  const h = harness(() => { if (++count === 1) { started(); return late; } return completion(plan()); });
  const controller = new AbortController();
  const rejected = assert.rejects(h.provider.plan(input(), controller.signal), { name: 'AbortError' });
  await entered; controller.abort();
  const otherScope = { ...scope, characterId: 'sweetheart' as const, turnId: 'other', generation: 2 };
  const other = await h.provider.plan(input([source('other:user', '另一角色的消息', { scope: otherScope })]), signal());
  release(completion(plan())); await rejected;
  assert.deepEqual(other.scope, otherScope); assert.deepEqual(other.changes, []);
  assert.deepEqual(h.authorizations.map(call => call.scope.characterId), ['friend', 'sweetheart']);
  assert.deepEqual(h.outcomes.map(outcome => outcome.status), ['success', 'cancelled']);
  assert.equal(h.requests.length, 2);
});

test('DeepSeek request snapshot survives caller mutation while awaiting a reply', async () => {
  let release!: (response: Response) => void, started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const late = new Promise<Response>(resolve => { release = resolve; });
  const h = harness(() => { started(); return late; });
  const original: MemoryTurnInput = structuredClone(rawOnly.input), before = structuredClone(original);
  const pending = h.provider.plan(original, signal()); await entered;
  Object.assign(original.scope, { characterId: 'sweetheart', turnId: 'replacement' });
  Object.assign(original.sources[1]!, { text: '调用方后来换成的文本' });
  release(completion(validForget()));
  const result = await pending;
  assert.deepEqual(result.scope, before.scope);
  assert.deepEqual(result.retainSources, [{ source: ref('mixed-user'), fragmentId: 'f0', start: 15, end: 23, supportSourceIds: [] }]);
  assert.deepEqual(JSON.parse(h.requests[0]!.body.messages[1].content), rawOnly.originalData);
});
