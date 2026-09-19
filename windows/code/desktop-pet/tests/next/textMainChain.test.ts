// NEXT-04: the text main chain over production components — NextTurnPort + DialoguePipeline +
// SqliteLifecycleMemoryPort on real temp SQLite — with only the providers faked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ConversationMessage, DialogueReply, DialogueRequest, MemoryChange, MemoryMaintenanceInput, TurnScope } from '../../contracts/index.js';
import type { MemoryTurnInput, MemoryTurnPlan } from '../../contracts/memory-lifecycle.js';
import { confirmedInvitationPolicy } from '../../companion/invitations.js';
import { SqliteMemoryStore, CONFIRMED_RETENTION } from '../../memory/sqlite-store.js';
import { SqliteLifecycleMemoryPort } from '../../memory/sqlite-lifecycle-port.js';
import { MemoryMediaStore } from '../../media/store.js';
import { NextTurnPort } from '../../core/turn-port.js';
import type { TurnPortEvent } from '../../core/turn-port.js';
import { deferred, tick } from './harness.js';

const NOW = '2026-09-19T00:00:00.000Z';
const BUDGET = 5000;

const noPlan = (input: MemoryTurnInput): MemoryTurnPlan =>
  ({ scope: input.scope, request: 'none', changes: [], suppressSources: [], clarification: null, reason: '无记忆相关内容' });

function userMessage(scope: TurnScope, text: string): ConversationMessage {
  return { characterId: scope.characterId, id: `${scope.turnId}:user`, role: 'user', text, createdAt: NOW };
}

function fixedScope(sessionId: string, turnId: string): TurnScope {
  return { characterId: 'companion', sessionId, turnId, generation: 1 };
}

interface ReplyPlan { gate?: ReturnType<typeof deferred<void>>; text?: string; failure?: Error }

interface Setup {
  port: NextTurnPort;
  lifecycle: SqliteLifecycleMemoryPort;
  store: SqliteMemoryStore;
  filename: string;
  events: TurnPortEvent[];
  requests: DialogueRequest[];
  /** Keyed by user text; must be set before submit to avoid races. */
  replies: Map<string, ReplyPlan>;
  setPlan(script: (input: MemoryTurnInput) => MemoryTurnPlan): void;
  setPropose(handler: (input: MemoryMaintenanceInput) => Promise<MemoryChange[]>): void;
  cleanup(): Promise<void>;
}

interface Reopen { store: SqliteMemoryStore; lifecycle: SqliteLifecycleMemoryPort }

async function makeSetup(options: { maxRecentMessages?: number } = {}): Promise<Setup> {
  const dir = await mkdtemp(join(tmpdir(), 'next-chain-'));
  const filename = resolve(dir, 'companion.sqlite');
  const store = new SqliteMemoryStore({ filename, retention: CONFIRMED_RETENTION, invitations: confirmedInvitationPolicy('Asia/Shanghai') });
  const replies = new Map<string, ReplyPlan>();
  const requests: DialogueRequest[] = [];
  let planScript: (input: MemoryTurnInput) => MemoryTurnPlan = noPlan;
  let proposeHandler: (input: MemoryMaintenanceInput) => Promise<MemoryChange[]> = async () => [];

  const lifecycle = new SqliteLifecycleMemoryPort(store, {
    context: { summaryLimit: 1000, inputTokenBudget: BUDGET, maxRecentMessages: options.maxRecentMessages ?? 20, maxMemories: 5, countTokens: () => 0, relevance: () => 0 },
    turn: { inputTokenBudget: 4000, countTokens: () => 0, provider: { plan: async input => planScript(input) }, maxSupplementaryPlans: 0 },
    summary: { inputTokenBudget: 4000, countTokens: () => 0, minMessages: 50, maxMessages: 100, provider: { summarize: async input => ({ scope: input.scope, text: '摘要', sourceVersions: [] }) } }
  }, { propose: async input => proposeHandler(input) });

  const media = new MemoryMediaStore();
  const port = new NextTurnPort({
    outputMode: 'text',
    perception: { perceive: async () => { throw new Error('voice is out of scope for this suite'); } },
    dialogue: {
      reply: async request => {
        requests.push(request);
        const plan = replies.get(request.text);
        if (plan?.gate) await plan.gate.promise;
        if (plan?.failure) throw plan.failure;
        const reply: DialogueReply = { scope: request.scope, text: plan?.text ?? `回复：${request.text}`, expression: { emotion: 'neutral', intensity: 0, delivery: '', gesture: null } };
        return reply;
      }
    },
    tts: { synthesize: async () => { throw new Error('voice is out of scope for this suite'); } },
    playback: { play: async () => {}, stop: async () => {} },
    memory: lifecycle,
    memoryLifecycle: lifecycle,
    mediaStore: { put: (scope, bytes, mimeType) => media.put(scope, bytes, mimeType), read: (scope, asset) => media.read(scope, asset), releaseScope: async () => {} }
  });
  const events: TurnPortEvent[] = [];
  port.subscribe(event => events.push(event));
  return {
    port, lifecycle, store, filename, events, requests, replies,
    setPlan(script: (input: MemoryTurnInput) => MemoryTurnPlan) { planScript = script; },
    setPropose(handler: (input: MemoryMaintenanceInput) => Promise<MemoryChange[]>) { proposeHandler = handler; },
    cleanup: async () => { store.close(); await rm(dir, { recursive: true, force: true }); }
  };
}

async function reopen(filename: string, planScript: (input: MemoryTurnInput) => MemoryTurnPlan, propose?: (input: MemoryMaintenanceInput) => Promise<MemoryChange[]>): Promise<Reopen> {
  const store = new SqliteMemoryStore({ filename, retention: CONFIRMED_RETENTION, invitations: confirmedInvitationPolicy('Asia/Shanghai') });
  const lifecycle = new SqliteLifecycleMemoryPort(store, {
    context: { summaryLimit: 1000, inputTokenBudget: BUDGET, maxRecentMessages: 20, maxMemories: 5, countTokens: () => 0, relevance: () => 0 },
    turn: { inputTokenBudget: 4000, countTokens: () => 0, provider: { plan: async input => planScript(input) }, maxSupplementaryPlans: 0 },
    summary: { inputTokenBudget: 4000, countTokens: () => 0, minMessages: 50, maxMessages: 100, provider: { summarize: async input => ({ scope: input.scope, text: '摘要', sourceVersions: [] }) } }
  }, propose ? { propose: async input => propose(input) } : undefined);
  return { store, lifecycle };
}

function waitForTerminal(events: TurnPortEvent[], port: NextTurnPort, scope: TurnScope): Promise<Extract<TurnPortEvent, { type: 'terminal' }>> {
  const seen = events.find(event => event.type === 'terminal' && event.scope.turnId === scope.turnId);
  if (seen) return Promise.resolve(seen as Extract<TurnPortEvent, { type: 'terminal' }>);
  return new Promise(done => {
    const unsubscribe = port.subscribe(event => {
      if (event.type === 'terminal' && event.scope.turnId === scope.turnId) { unsubscribe(); done(event); }
    });
  });
}

const terminalsFor = (events: TurnPortEvent[], turnId: string) => events.filter(event => event.type === 'terminal' && event.scope.turnId === turnId);

test('04-A multi-turn conversation: the next real context contains the previous turn content', async t => {
  const setup = await makeSetup();
  t.after(() => setup.cleanup());
  const first = await setup.port.submit({ text: '我最喜欢的城市是京都' });
  const firstEnd = await waitForTerminal(setup.events, setup.port, first);
  assert.equal(firstEnd.status, 'completed');
  assert.equal(firstEnd.replyText, '回复：我最喜欢的城市是京都');

  const second = await setup.port.submit({ text: '我最喜欢的城市叫什么？' });
  const secondEnd = await waitForTerminal(setup.events, setup.port, second);
  assert.equal(secondEnd.status, 'completed');
  const secondRequest = setup.requests[1]!;
  assert.ok(secondRequest.context.recent.some(m => m.text === '我最喜欢的城市是京都'), 'previous user turn is in the real context');
  assert.ok(secondRequest.context.recent.some(m => m.text === '回复：我最喜欢的城市是京都'), 'previous assistant reply is in the real context');
  assert.equal(secondRequest.context.inputTokenBudget, BUDGET, 'budget comes from the fixed configuration');
});

test('04-B quick A→B: A ends cancelled exactly once, late provider data cannot write back; cancel is idempotent', async t => {
  const setup = await makeSetup();
  t.after(() => setup.cleanup());
  const gate = deferred<void>();
  setup.replies.set('会被取消的问题', { gate, text: '迟到的回复' });

  const first = await setup.port.submit({ text: '会被取消的问题' });
  await tick();

  const second = await setup.port.submit({ text: '新的问题' });
  const secondEnd = await waitForTerminal(setup.events, setup.port, second);
  assert.equal(secondEnd.status, 'completed');

  gate.resolve();
  const firstEnd = await waitForTerminal(setup.events, setup.port, first);
  assert.equal(firstEnd.status, 'cancelled');
  assert.equal(terminalsFor(setup.events, first.turnId).length, 1, 'terminal exactly once');
  setup.port.cancel(first);
  setup.port.cancel(first);
  await tick();
  assert.equal(terminalsFor(setup.events, first.turnId).length, 1, 'idempotent cancel emits nothing more');

  const followup = await setup.port.submit({ text: '我们刚才聊到哪了？' });
  await waitForTerminal(setup.events, setup.port, followup);
  const followupRequest = setup.requests.at(-1)!;
  assert.ok(!followupRequest.context.recent.some(m => m.text === '迟到的回复'), 'the late reply never reached real memory');
  assert.ok(followupRequest.context.recent.some(m => m.text === '回复：新的问题'), 'the winner turn is intact in real memory');
});

test('04-C two sessions share the store but turn scopes never cross; budget truncation is real', async t => {
  const setup = await makeSetup({ maxRecentMessages: 2 });
  t.after(() => setup.cleanup());
  const eventsA: TurnPortEvent[] = [];
  const sessionA = new NextTurnPort({
    outputMode: 'text',
    perception: { perceive: async () => { throw new Error('unused'); } },
    dialogue: { reply: async request => ({ scope: request.scope, text: `A：${request.text}`, expression: { emotion: 'neutral', intensity: 0, delivery: '', gesture: null } }) },
    tts: { synthesize: async () => { throw new Error('unused'); } },
    playback: { play: async () => {}, stop: async () => {} },
    memory: setup.lifecycle,
    memoryLifecycle: setup.lifecycle,
    mediaStore: { put: async () => { throw new Error('unused'); }, read: async () => { throw new Error('unused'); }, releaseScope: async () => {} }
  });
  sessionA.subscribe(event => eventsA.push(event));
  assert.notEqual(sessionA.identity().sessionId, setup.port.identity().sessionId, 'separate runtime identities');

  for (let i = 1; i <= 3; i++) {
    const scopeB = await setup.port.submit({ text: `B 的第 ${i} 句` });
    const endB = await waitForTerminal(setup.events, setup.port, scopeB);
    assert.equal(endB.status, 'completed');
    const scopeA = await sessionA.submit({ text: `A 的第 ${i} 句` });
    const endA = await new Promise<Extract<TurnPortEvent, { type: 'terminal' }>>(done => {
      const unsubscribe = sessionA.subscribe(event => { if (event.type === 'terminal' && event.scope.turnId === scopeA.turnId) { unsubscribe(); done(event); } });
    });
    assert.equal(endA.status, 'completed');
    assert.equal(eventsA.filter(event => event.type === 'terminal' && event.scope.turnId === scopeA.turnId).length, 1);
  }
  for (const request of setup.requests) {
    assert.ok(request.context.recent.length <= 2, 'recent is capped by the configured budget');
    assert.equal(request.context.inputTokenBudget, BUDGET);
  }
  const activeB = await setup.port.submit({ text: 'B 的活跃轮' });
  sessionA.cancel();
  const endB = await waitForTerminal(setup.events, setup.port, activeB);
  assert.equal(endB.status, 'completed', 'session A cancel must not affect session B');
});

test('04-D persistence reopen, correction returns the new value, forget sticks against stale write-back', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'next-chain-persist-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filename = resolve(dir, 'companion.sqlite');
  const context = { summaryLimit: 1000, inputTokenBudget: BUDGET, maxRecentMessages: 20, maxMemories: 5, countTokens: () => 0, relevance: () => 0 };
  let planScript: (input: MemoryTurnInput) => MemoryTurnPlan = noPlan;
  let proposeHandler: (input: MemoryMaintenanceInput) => Promise<MemoryChange[]> = async () => [];

  const store = new SqliteMemoryStore({ filename, retention: CONFIRMED_RETENTION, invitations: confirmedInvitationPolicy('Asia/Shanghai') });
  const lifecycle = new SqliteLifecycleMemoryPort(store, {
    context,
    turn: { inputTokenBudget: 4000, countTokens: () => 0, provider: { plan: async input => planScript(input) }, maxSupplementaryPlans: 0 },
    summary: { inputTokenBudget: 4000, countTokens: () => 0, minMessages: 50, maxMessages: 100, provider: { summarize: async input => ({ scope: input.scope, text: '摘要', sourceVersions: [] }) } }
  }, { propose: async input => proposeHandler(input) });

  const seedScope = fixedScope('session-main', 'seed');
  await lifecycle.append(seedScope, [userMessage(seedScope, '我养了一只猫叫小白')]);
  store.close();

  const reopened = await reopen(filename, input => planScript(input), input => proposeHandler(input));
  const reopenedContext = await reopened.lifecycle.context(fixedScope('session-main', 'probe'), '猫', null, new AbortController().signal);
  assert.ok(reopenedContext.recent.some(m => m.text === '我养了一只猫叫小白'), 'valid content is retained after reopen');

  // Add a memory from the persisted transcript via the production turn machinery.
  // The plan's sourceIds must reference the real persisted transcript ('seed:user'), or the source graph rejects the change.
  planScript = input => ({ scope: input.scope, request: 'none', changes: [{ scope: input.scope, operationId: 'op-add', reason: '宠物事实', createdAt: NOW, operation: { type: 'add', id: 'mem-cat', text: '用户养了一只叫小白的猫', sourceIds: [input.currentMessageId] } }], suppressSources: [], clarification: null, reason: 'pet fact' });
  const addOutcome = await reopened.lifecycle.prepareTurn(seedScope, `${seedScope.turnId}:user`, '我养了一只猫叫小白', new AbortController().signal);
  assert.equal(addOutcome.status, 'applied');
  const withCat = await reopened.lifecycle.context(fixedScope('session-main', 'probe2'), '猫', null, new AbortController().signal);
  const catMemory = withCat.memories.find(m => m.text.includes('小白'));
  assert.ok(catMemory, 'the added memory is retrievable');

  // Correct it: retrieval returns the new value only.
  const correctScope = fixedScope('session-main', 'correct');
  await reopened.lifecycle.append(correctScope, [userMessage(correctScope, '改口：我的猫叫小黑')]);
  const correctedText = '用户养了一只叫小黑的猫';
  const sourceRef = (input: MemoryTurnInput, id: string) => {
    const source = input.sources.find(s => s.id === id)!;
    return { id: source.id, version: source.version };
  };
  const retainCurrent = (input: MemoryTurnInput) => {
    const current = input.sources.find(s => s.id === input.currentMessageId)!;
    return [{ source: { id: current.id, version: current.version }, fragmentId: 'f0', start: 0, end: [...current.text].length, supportSourceIds: [] }];
  };
  let lastPlanInput: MemoryTurnInput | undefined;
  planScript = input => {
    lastPlanInput = input;
    const stale = input.relevantMemories.find(m => m.text.includes('小白'))!;
    // A correction consumes the raw utterances feeding the corrected memory: the current message
    // plus the memory's existing sources must all be explicitly suppressed, with a retained
    // fragment of the current message as the new value's evidence.
    const suppress = [{ id: input.currentMessageId, version: sourceRef(input, input.currentMessageId).version }];
    for (const sid of stale.sourceIds) {
      const found = input.sources.find(s => s.id === sid);
      if (found) suppress.push({ id: found.id, version: found.version });
    }
    // The updated memory cites the retained fragment alias (f0) — the raw utterance itself is suppressed.
    return { scope: input.scope, request: 'correction', changes: [{ scope: input.scope, operationId: 'op-fix', reason: '用户改口', createdAt: NOW, operation: { type: 'update', id: stale.id, expectedVersion: stale.version, text: correctedText, sourceIds: ['f0'] } }], suppressSources: suppress, retainSources: retainCurrent(input), clarification: null, reason: 'correction' };
  };
  const correctOutcome = await reopened.lifecycle.prepareTurn(correctScope, `${correctScope.turnId}:user`, '改口：我的猫叫小黑', new AbortController().signal);
  assert.equal(correctOutcome.status, 'applied', JSON.stringify({ status: correctOutcome.status, rejectionCode: correctOutcome.rejectionCode ?? null, sources: lastPlanInput?.sources.map(s => ({ id: s.id, version: s.version, kind: s.kind, eligible: s.evidenceEligible })) ?? null }));
  assert.ok(correctOutcome.retrievalInvalidated);
  const afterFix = await reopened.lifecycle.context(fixedScope('session-main', 'probe3'), '猫', null, new AbortController().signal);
  assert.ok(afterFix.memories.some(m => m.text === correctedText), 'correction returns the new value');
  assert.ok(!afterFix.memories.some(m => m.text.includes('小白')), 'the old value is gone');

  // Forget it; then a stale in-flight write-back must not revive it.
  const forgetScope = fixedScope('session-main', 'forget');
  await reopened.lifecycle.append(forgetScope, [userMessage(forgetScope, '把猫的事忘了吧')]);
  planScript = input => {
    const target = input.relevantMemories.find(m => m.text === correctedText)!;
    // The forget must disposition every raw source feeding the memory, including the retained
    // fragment's parent transcript from the earlier correction.
    const suppress = [{ id: input.currentMessageId, version: sourceRef(input, input.currentMessageId).version }];
    for (const sid of target.sourceIds) {
      const found = input.sources.find(s => s.id === sid);
      if (found) suppress.push({ id: found.id, version: found.version });
    }
    return { scope: input.scope, request: 'forget', changes: [{ scope: input.scope, operationId: 'op-forget', reason: '用户要求遗忘', createdAt: NOW, operation: { type: 'soft_delete', id: target.id, expectedVersion: target.version } }], suppressSources: suppress, retainSources: [], clarification: null, reason: 'forget' };
  };
  const forgetOutcome = await reopened.lifecycle.prepareTurn(forgetScope, `${forgetScope.turnId}:user`, '把猫的事忘了吧', new AbortController().signal);
  assert.equal(forgetOutcome.status, 'applied', JSON.stringify({ status: forgetOutcome.status, rejectionCode: forgetOutcome.rejectionCode ?? null }));
  const afterForget = await reopened.lifecycle.context(fixedScope('session-main', 'probe4'), '猫', null, new AbortController().signal);
  assert.ok(!afterForget.memories.some(m => m.text === correctedText), 'forgotten content is not retrievable');

  const lateScope = fixedScope('session-main', 'late');
  // The late task references a really stored, still-active message (earlier raw utterances were
  // already disposed by their own turns — that is exactly the suppression semantics under test).
  await reopened.lifecycle.append(lateScope, [userMessage(lateScope, '今天天气不错')]);
  const staleMaintenance: MemoryMaintenanceInput = {
    scope: lateScope,
    messages: [userMessage(lateScope, '今天天气不错')],
    relevantMemories: [{ characterId: 'companion', id: catMemory!.id, version: catMemory!.version, text: correctedText, sourceIds: [], origin: 'conversation' }]
  };
  proposeHandler = async input => [{ scope: input.scope, operationId: 'op-restore', reason: '迟到的维护任务', createdAt: NOW, operation: { type: 'restore', id: catMemory!.id, expectedVersion: catMemory!.version } }];
  // The maintenance path refuses a task whose referenced memory no longer matches (stale version /
  // deleted state): the late write-back fails loudly instead of restoring forgotten content.
  await assert.rejects(reopened.lifecycle.maintain(staleMaintenance, new AbortController().signal), /maintenance_memory_mismatch/);
  const final = await reopened.lifecycle.context(fixedScope('session-main', 'probe5'), '猫', null, new AbortController().signal);
  assert.ok(!final.memories.some(m => m.text === correctedText), 'forgotten content stays forgotten');
  reopened.store.close();
});

test('04-E provider failure produces no fake completion and the next turn continues', async t => {
  const setup = await makeSetup();
  t.after(() => setup.cleanup());
  setup.replies.set('触发模型故障', { failure: new Error('model unavailable') });
  const broken = await setup.port.submit({ text: '触发模型故障' });
  const brokenEnd = await waitForTerminal(setup.events, setup.port, broken);
  assert.equal(brokenEnd.status, 'failed');
  assert.ok(!setup.events.some(event => event.type === 'reply' && event.scope.turnId === broken.turnId), 'no reply event for the failed turn');

  const next = await setup.port.submit({ text: '故障后继续聊' });
  const nextEnd = await waitForTerminal(setup.events, setup.port, next);
  assert.equal(nextEnd.status, 'completed');
  const nextRequest = setup.requests.at(-1)!;
  assert.ok(nextRequest.context.recent.some(m => m.text === '触发模型故障'), 'the user side of the failed turn is still real history');
  assert.ok(!nextRequest.context.recent.some(m => m.text === '回复：触发模型故障'), 'no assistant reply was invented for the failed turn');
});
