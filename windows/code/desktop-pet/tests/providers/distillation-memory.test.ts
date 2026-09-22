import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, scope, message } from '../memory/sqlite-fixture.js';
import { signal } from '../memory/lifecycle-fixture.js';
import { DistillationMemoryTurnProvider } from '../../providers/distillation-memory-provider.js';
import { ProviderTransport, type EndpointConfig } from '../../providers/transport.js';
import { SqliteLifecycleMemoryPort } from '../../memory/sqlite-lifecycle-port.js';

test('N075-01 R3: DistillationMemoryTurnProvider plans formal MemoryTurnPlan from user utterance', async () => {
  const capturedMessages: unknown[] = [];
  const fakeTransport = new ProviderTransport(async (input, init) => {
    capturedMessages.push(JSON.parse(String(init?.body ?? '{}')));
    return new Response(JSON.stringify({
      choices: [{
        finish_reason: 'stop',
        message: {
          content: JSON.stringify({
            hasMemory: true,
            fact: '用户平时喜欢喝无糖乌龙茶',
            category: 'preference',
          }),
        },
      }],
    }));
  });

  const endpointConfig: EndpointConfig = {
    model: 'mock-distill-model',
    endpoint: 'https://unit.invalid/chat/completions',
    apiKey: () => 'mock-key',
    authorizer: { async authorize() { return { async settle() {} }; } },
  };

  const provider = new DistillationMemoryTurnProvider(endpointConfig, fakeTransport);

  const turnScope = scope('companion', 'turn-distill-1');
  const plan = await provider.plan({
    scope: turnScope,
    currentMessageId: 'msg-user-1',
    messages: [
      { characterId: 'companion', id: 'msg-user-1', role: 'user', text: '我平时最常喝无糖乌龙茶。', createdAt: '2026-09-22T00:00:00Z' },
    ],
    relevantMemories: [],
    sources: [
      { scope: turnScope, id: 'msg-user-1', version: 1, kind: 'transcript', text: '我平时最常喝无糖乌龙茶。', createdAt: '2026-09-22T00:00:00Z', messageRole: 'user' },
    ],
  }, signal());

  assert.equal(plan.request, 'none');
  assert.equal(plan.changes.length, 1);
  const change = plan.changes[0]!;
  assert.equal(change.operation.type, 'add');
  if (change.operation.type === 'add') {
    assert.equal(change.operation.text, '用户平时喜欢喝无糖乌龙茶');
    assert.deepEqual(change.operation.sourceIds, ['msg-user-1'], 'Strict source lineage to current message');
  }
});

test('N075-01 R3: formal background lifecycle commits distilled memory through commitTurn', async t => {
  const f = fixture();
  t.after(f.cleanup);
  const store = f.open();

  let distillCallCount = 0;
  const fakeTransport = new ProviderTransport(async () => {
    distillCallCount++;
    return new Response(JSON.stringify({
      choices: [{
        finish_reason: 'stop',
        message: {
          content: JSON.stringify({
            hasMemory: true,
            fact: '用户名字叫老朱',
            category: 'identity',
          }),
        },
      }],
    }));
  });

  const endpointConfig: EndpointConfig = {
    model: 'mock-distill-model',
    endpoint: 'https://unit.invalid/chat/completions',
    apiKey: () => 'mock-key',
    authorizer: { async authorize() { return { async settle() {} }; } },
  };

  const distillProvider = new DistillationMemoryTurnProvider(endpointConfig, fakeTransport);

  const port = new SqliteLifecycleMemoryPort(store, {
    context: {
      inputTokenBudget: 20000,
      maxRecentMessages: 12,
      maxMemories: 8,
      summaryLimit: 4,
      countTokens: () => 100,
      relevance: () => 1,
    },
    turn: {
      provider: distillProvider,
      inputTokenBudget: 20000,
      countTokens: () => 100,
    },
    summary: {
      provider: { summarize: async input => ({ scope: input.scope, text: '摘要', sourceVersions: [] }) },
      minMessages: 10,
      maxMessages: 20,
      inputTokenBudget: 10000,
      countTokens: () => 100,
    },
  });

  const turn1 = scope('companion', 'turn-1');
  const userMsg = message('turn-1:user', '以后叫我老朱。');
  await port.append(turn1, [userMsg]);

  // Execute formal background turn
  const outcome = await port.prepareBackgroundTurn(turn1, 'turn-1:user', '以后叫我老朱。', signal());

  assert.equal(outcome.status, 'applied', 'Outcome must be applied through commitTurn');
  assert.equal(outcome.affectedIds.length, 1);
  assert.equal(distillCallCount, 1);

  // Verify record in SQLite store
  const memRecord = store.inspect(turn1, outcome.affectedIds[0]!);
  assert.ok(memRecord, 'Record must exist in memory_records');
  assert.equal(memRecord.state, 'active');
  assert.equal(memRecord.kind, 'memory');
  assert.equal(memRecord.text, '用户名字叫老朱');
  assert.deepEqual(memRecord.sources.map(s => s.id), ['turn-1:user'], 'Must link to transcript source');

  // Next turn: verify foreground context recalls this committed memory
  const turn2 = scope('companion', 'turn-2');
  await port.append(turn2, [message('turn-2:user', '老朱')]);
  const context2 = await port.foregroundContext(turn2, 'turn-2:user', '老朱', null, signal());

  const recalledTexts = context2.memories.map(m => m.text);
  assert.ok(recalledTexts.includes('用户名字叫老朱'), 'Committed memory is recalled in subsequent turn');
});
