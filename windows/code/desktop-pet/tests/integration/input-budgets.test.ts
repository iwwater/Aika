import test from 'node:test';
import assert from 'node:assert/strict';
import type { TurnScope } from '../../contracts/index.js';
import type { MemorySource, MemoryTurnInput } from '../../contracts/memory-lifecycle.js';
import { memoryTurnInputUpperBound, summaryInputUpperBound } from '../../app/input-budgets.js';
import { MEMORY_TURN_PROMPT } from '../../providers/memory-lifecycle-prompt.js';
import { QwenMemoryTurnProvider, QwenSummaryProvider } from '../../providers/qwen-memory-lifecycle.js';
import { ProviderTransport } from '../../providers/transport.js';
import { evaluateLifecycle } from '../../app/evaluate-lifecycle.js';
import type { MemoryWireMode } from '../../providers/memory-wire.js';

function largeSyntheticInput(): MemoryTurnInput {
  const scope: TurnScope = { characterId: 'friend', sessionId: 'synthetic-budget-session', turnId: 'current-budget-request', generation: 1 };
  const sources: MemorySource[] = [];
  const raw = (suffix: string, text: string, role: 'user' | 'assistant') => {
    const id = `source-4edcf016-13de-48b0-af47-63e61cb34700-${suffix}`;
    sources.push({ scope, id, kind: 'transcript', text, createdAt: '2026-09-06T12:00:00Z', messageRole: role, version: 1, evidenceEligible: true,
      sourceVersions: role === 'assistant' ? sources.filter(source => source.kind === 'transcript').map(source => ({ id: source.id, version: source.version })) : [] });
    return id;
  };
  const origin = raw('cat', '我的猫叫团子', 'user');
  for (let index = 0; index < 20; index++) { raw(`user-${index}`, '今天聊聊日常安排', 'user'); raw(`assistant-${index}`, '收到，我们聊今天的安排。', 'assistant'); }
  const currentMessageId = raw('current', '忘记我养猫和猫咪名字这件事。', 'user');
  const memory: MemorySource = { scope, id: 'cat-memory', kind: 'memory', text: '用户的猫叫团子', version: 1, createdAt: sources[0]!.createdAt, messageRole: null, evidenceEligible: true, sourceVersions: [{ id: origin, version: 1 }] };
  sources.push(memory);
  return { scope, currentMessageId, sources, messages: sources.filter(source => source.kind === 'transcript').map(source => ({ characterId: scope.characterId, id: source.id, role: source.messageRole!, text: source.text, createdAt: source.createdAt })), relevantMemories: [{ characterId: scope.characterId, id: memory.id, version: 1, text: memory.text, sourceIds: [origin] }] };
}
for (const mode of ['numeric-v1', 'quoted-v2'] as const) test(`${mode} memory bound counts the actual complete provider wire`, async () => {
  const input = largeSyntheticInput();
  let sentBytes = 0, sentSources = 0;
  const transport = new ProviderTransport(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    sentBytes = body.messages.reduce((sum: number, message: { content: string }) => sum + Buffer.byteLength(message.content), 0);
    const data = JSON.parse(body.messages[1].content); sentSources = data.evidence.length + 1;
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ request: 'none', changes: [], suppressSources: [], retainSources: [], clarification: null, reason: 'controlled protocol fixture only' }) } }] });
  });
  const config = { endpoint: 'https://unit.invalid/completions', model: 'fixture', apiKey: () => 'fixture-only', authorizer: { async authorize() { return { async settle() {} }; } } };
  await new QwenMemoryTurnProvider(config, transport, mode).plan(input, new AbortController().signal);
  const bound = memoryTurnInputUpperBound(input, mode);
  assert.equal(memoryTurnInputUpperBound(input), memoryTurnInputUpperBound(input, 'numeric-v1'), 'archived numeric mode remains the default');
  assert.equal(sentSources, 43); assert.equal(bound, sentBytes + 2048);
  assert.ok(bound < 32_768, `wire bound ${bound}`);
  assert.ok(Buffer.byteLength(JSON.stringify(input)) + Buffer.byteLength(MEMORY_TURN_PROMPT) + 2048 > 32_768);
});
test('evaluation rejects unknown or unused memory modes before reading credentials or creating a run', async () => {
  await assert.rejects(evaluateLifecycle('/nonexistent-evaluation-root', '/must-not-read-credentials', 'lifecycle-invalid-mode', 'source-originals', 'guess' as MemoryWireMode), /Unknown memory wire mode/);
  for (const suite of ['dialogue', 'absence'] as const) {
    await assert.rejects(evaluateLifecycle('/nonexistent-evaluation-root', '/must-not-read-credentials', 'lifecycle-unused-mode', suite, 'quoted-v2'), /not applicable/);
  }
});
test('summary input bound covers exactly the complete serialized source table and current prompt', async () => {
  const input = largeSyntheticInput(); let sentBytes = 0;
  const transport = new ProviderTransport(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    sentBytes = body.messages.reduce((sum: number, message: { content: string }) => sum + Buffer.byteLength(message.content), 0);
    const data = JSON.parse(body.messages[1].content);
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ text: '合成摘要。', sourceVersions: data.sources.map((source: {id: string; version: number}) => ({ id: source.id, version: source.version })) }) } }] });
  });
  const config = { endpoint: 'https://unit.invalid/completions', model: 'fixture', apiKey: () => 'fixture-only', authorizer: { async authorize() { return { async settle() {} }; } } };
  await new QwenSummaryProvider(config, transport).summarize(input, new AbortController().signal);
  assert.equal(summaryInputUpperBound(input), sentBytes + 2048);
});
