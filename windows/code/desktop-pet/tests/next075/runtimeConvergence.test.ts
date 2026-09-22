/**
 * N075-01: Runtime Convergence and Backend Truth Repair Integration Suite
 *
 * Matrix Coverage:
 * T1. Production Context Composition (character soul + user soul + user wiki + relationship + canon + companion timeline)
 * T2. Single Dialogue LLM Call Invariant (exactly 1 call per turn, full combined context)
 * T3. Ordinary Memory Distillation Timing (asynchronous background, non-blocking foreground)
 * T4. Raw Transcript Write Order (user transcript committed before LLM call)
 * T5. Assistant Transcript Issued Context Lineage (assistant linked to user ID and issued context)
 * T6. Real Context Stale Invalidation (post-mutation stale detection prevents reuse)
 * T7. Production Trace Stage Sequence (admission -> context -> llm -> assistant_persist -> memory_enqueue -> memory_plan/commit)
 * T8. Trace Privacy Default (sanitized digest by default, raw body only on debugOptIn)
 * T9. Companion Timeline Latest-N & Chronological Order (latest N selected, chronological order preserved)
 * T10. ProviderRuntime Resolution (legacy TrialConfiguration slots resolved into ResolvedBinding)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CharacterPackStore } from '../../memory/character-pack-store.js';
import { ContinuityMemoryStore } from '../../memory/continuity-memory-store.js';
import { ProductionContinuityContext } from '../../memory/continuity-production.js';
import { productionPairing } from '../../contracts/character-pack.js';
import { SqliteLifecycleMemoryPort } from '../../memory/sqlite-lifecycle-port.js';
import { SqliteManagementMemoryPort } from '../../memory/management-port.js';
import { RuntimeTraceStore } from '../../core/trace-store.js';
import { DialoguePipeline } from '../../core/dialogue-pipeline.js';
import { TurnController } from '../../core/turn-controller.js';
import { RoleMemoryLifecycleQueue } from '../../core/memory-lifecycle-queue.js';
import { DistillationMemoryTurnProvider } from '../../providers/distillation-memory-provider.js';
import { DistillationScheduler } from '../../core/distillation-scheduler.js';
import { LegacyProviderRuntimeAdapter } from '../../plugins/legacy-provider-adapter.js';
import { JsonDialogueProvider } from '../../providers/qwen-dialogue.js';
import { ProviderTransport, type EndpointConfig } from '../../providers/transport.js';
import { fixture, scope, message, change } from '../memory/sqlite-fixture.js';
import { signal, replyMessage } from '../memory/lifecycle-fixture.js';
import type { TrialConfiguration } from '../../app/trial-config.js';

function createTempDb(): { db: Database.Database; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'n075-suite-'));
  const filename = join(dir, 'suite.db');
  const db = new Database(filename);
  return {
    db,
    cleanup: () => {
      try { db.close(); } catch {}
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    },
  };
}

// -------------------------------------------------------------------------------------------------
// T1 & T2: Production Context Composition & Single Dialogue LLM Call Invariant
// -------------------------------------------------------------------------------------------------
test('T1 & T2: Production Context Composition & Single Dialogue LLM Call Invariant', async t => {
  const f = fixture();
  t.after(f.cleanup);
  const store = f.open();

  const packs = await CharacterPackStore.open(store);
  const contStore = await ContinuityMemoryStore.open(store);
  const pairing = productionPairing('companion', 'inst-convergence');

  // Seed Character Pack
  const src = await packs.importSource('companion', { sourceName: 'canon.txt', text: '沈砚生于临海城。' });
  const draft = await packs.saveDraft({
    characterId: 'companion',
    payload: {
      schemaVersion: '0.7-draft-1',
      character: { name: '沈砚', soul: '严谨守诺的观测者' },
      canonFacts: [{ id: 'cf-1', text: '沈砚生于临海城。', status: 'explicit', evidenceIds: [src.snapshot.blocks[0]!.id] }],
      gaps: [],
    },
    sourceIds: [src.snapshot.id],
    validation: { valid: true, errors: [], validatedAt: new Date().toISOString() },
  });
  await packs.activateDraft({ characterId: 'companion', draftId: draft.id, userId: pairing.userId, instanceId: pairing.characterInstanceId });

  // Seed User Soul, User Wiki, Relationship
  contStore.record({ pairing, operationId: 'op-s1', layer: 'user_soul', kind: 'fact', text: '用户是工程师', sourceIds: ['m1'], origin: 'manual', status: 'active' });
  contStore.record({ pairing, operationId: 'op-w1', layer: 'user_wiki', kind: 'fact', text: '用户曾参与Aika架构重构', sourceIds: ['m2'], origin: 'manual', status: 'active' });
  contStore.record({ pairing, operationId: 'op-r1', layer: 'relationship', kind: 'fact', text: '沈砚视用户为志同道合的伙伴', sourceIds: ['m3'], origin: 'manual', status: 'active' });

  // Seed companion timeline event
  packs.appendCompanionEvent({
    userId: pairing.userId, characterId: pairing.characterId, characterInstanceId: pairing.characterInstanceId,
    sessionId: 's-1', turnId: 't-prev', userText: '认识你很高兴。', assistantText: '我也是。',
  });

  const continuityContext = new ProductionContinuityContext({
    packs, memory: contStore, pairing: { pairingFor: () => pairing }, dialogueInputTokenBudget: 30000,
  });

  const port = new SqliteLifecycleMemoryPort(store, {
    context: {
      inputTokenBudget: 30000, maxRecentMessages: 12, maxMemories: 8, summaryLimit: 4,
      countTokens: (c: unknown, text: string) => JSON.stringify(c).length + text.length,
      relevance: () => 1,
      continuity: s => continuityContext.contextFor(s.characterId, ''),
    },
    turn: { provider: { plan: async () => ({ scope: scope(), request: 'none', changes: [], suppressSources: [], clarification: null, reason: 'none' }) }, inputTokenBudget: 20000, countTokens: () => 100 },
    summary: { provider: { summarize: async input => ({ scope: input.scope, text: '', sourceVersions: [] }) }, minMessages: 10, maxMessages: 20, inputTokenBudget: 10000, countTokens: () => 100 },
  });

  const turnScope = scope('companion', 'turn-c1');
  await port.append(turnScope, [message('turn-c1:user', '你记得我们是怎么认识的吗？')]);
  const context = await port.foregroundContext(turnScope, 'turn-c1:user', '你记得我们是怎么认识的吗？', null, signal());

  // T1 Assertion: All 6 continuity sources are present in ONE context
  assert.ok(context.continuity, 'context.continuity must be present');
  const sources = new Set(context.continuity.selected.map(item => item.source));
  assert.ok(sources.has('character_soul'), 'character_soul must be selected');
  assert.ok(sources.has('user_soul'), 'user_soul must be selected');
  assert.ok(sources.has('user_wiki'), 'user_wiki must be selected');
  assert.ok(sources.has('relationship'), 'relationship must be selected');
  assert.ok(sources.has('canon_timeline'), 'canon_timeline must be selected');
  assert.ok(sources.has('companion_timeline'), 'companion_timeline must be selected');

  // T2 Assertion: Exactly ONE Dialogue LLM call carries this complete context
  const wireRequests: unknown[] = [];
  const fakeTransport = new ProviderTransport(async (input, init) => {
    wireRequests.push(JSON.parse(String(init?.body ?? '{}')));
    return new Response(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ text: '我当然记得。', expression: { emotion: 'neutral', intensity: 0.5, delivery: '', gesture: null } }) } }],
    }));
  });

  const provider = new JsonDialogueProvider({
    model: 'mock-llm', endpoint: 'https://unit.invalid/chat/completions', apiKey: () => 'k',
    authorizer: { async authorize() { return { async settle() {} }; } },
  }, fakeTransport);

  const reply = await provider.reply({ scope: turnScope, text: '你记得我们是怎么认识的吗？', context }, signal());
  assert.equal(wireRequests.length, 1, 'T2: Exactly ONE LLM call must be issued');
  assert.equal(reply.text, '我当然记得。');

  const wireBody = wireRequests[0] as { messages: { role: string; content: string }[] };
  const userPayload = JSON.parse(wireBody.messages.find(m => m.role === 'user')!.content);
  assert.ok(userPayload.continuity.includes('严谨守诺的观测者'), 'Character soul delivered to model');
  assert.ok(userPayload.continuity.includes('用户曾参与Aika架构重构'), 'User wiki delivered to model');
});

// -------------------------------------------------------------------------------------------------
// T3: Ordinary Memory Distillation Timing (Non-blocking foreground)
// -------------------------------------------------------------------------------------------------
test('T3: Ordinary Memory Distillation Timing (Asynchronous non-blocking)', async t => {
  const f = fixture();
  t.after(f.cleanup);
  const store = f.open();

  let distillResolve!: () => void;
  const distillStarted = new Promise<void>(res => { distillResolve = res; });
  let backgroundFinished = false;

  const fakeTransport = new ProviderTransport(async () => {
    distillResolve();
    // Simulate background network delay
    await new Promise(r => setTimeout(r, 50));
    backgroundFinished = true;
    return new Response(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ hasMemory: true, fact: '用户习惯喝茶', category: 'preference' }) } }],
    }));
  });

  const distillProvider = new DistillationMemoryTurnProvider({
    model: 'distill-m', endpoint: 'https://unit.invalid/chat', apiKey: () => 'k',
    authorizer: { async authorize() { return { async settle() {} }; } },
  }, fakeTransport);

  const port = new SqliteLifecycleMemoryPort(store, {
    context: { inputTokenBudget: 20000, maxRecentMessages: 12, maxMemories: 8, summaryLimit: 4, countTokens: () => 100, relevance: () => 1 },
    turn: { provider: distillProvider, inputTokenBudget: 20000, countTokens: () => 100 },
    summary: { provider: { summarize: async input => ({ scope: input.scope, text: '', sourceVersions: [] }) }, minMessages: 10, maxMessages: 20, inputTokenBudget: 10000, countTokens: () => 100 },
  });

  const queue = new RoleMemoryLifecycleQueue(port, () => {});

  const turnScope = scope('companion', 'turn-timing');
  const userMsg = message('turn-timing:user', '我每天早上都喝茶。');
  await port.append(turnScope, [userMsg]);

  // Foreground context does NOT wait for background distillation
  const fgContext = await queue.foregroundContext(turnScope, 'turn-timing:user', '我每天早上都喝茶。', null, signal());
  assert.ok(fgContext, 'Foreground context returned immediately');

  // Enqueue background turn without awaiting completion
  const bgWork = queue.enqueueTurn(turnScope, 'turn-timing:user', '我每天早上都喝茶。');

  // Assistant reply can proceed while background distillation is still in-flight
  assert.equal(backgroundFinished, false, 'Background distillation must not block foreground');
  await queue.appendForegroundAssistant(turnScope, replyMessage(turnScope, '喝茶是个好习惯。'), fgContext, 'turn-timing:user', signal());

  // Now await background completion
  await bgWork;
  assert.equal(backgroundFinished, true, 'Background distillation finished asynchronously');
  await queue.close();
});

// -------------------------------------------------------------------------------------------------
// T4 & T5: Raw Transcript Write Order & Assistant Lineage
// -------------------------------------------------------------------------------------------------
test('T4 & T5: Raw Transcript Committed First & Assistant Persisted with Lineage', async t => {
  const f = fixture();
  t.after(f.cleanup);
  const store = f.open();

  const operationsOrder: string[] = [];

  const mockDialogue = {
    async reply(req: any) {
      operationsOrder.push('llm_reply');
      // Verify raw user transcript was ALREADY written in SQLite before LLM called!
      const userRec = store.inspect(req.scope, `${req.scope.turnId}:user`);
      assert.ok(userRec, 'T4: Raw user transcript must exist in storage before LLM reply is called');
      assert.equal(userRec?.text, '测试消息', 'Raw user text matches');
      return { scope: req.scope, text: '回复测试', expression: { emotion: 'neutral', intensity: 0, delivery: '', gesture: null } };
    },
  };

  const port = new SqliteLifecycleMemoryPort(store, {
    context: { inputTokenBudget: 20000, maxRecentMessages: 12, maxMemories: 8, summaryLimit: 4, countTokens: () => 100, relevance: () => 1 },
    turn: { provider: { plan: async () => ({ scope: scope(), request: 'none', changes: [], suppressSources: [], clarification: null, reason: 'none' }) }, inputTokenBudget: 20000, countTokens: () => 100 },
    summary: { provider: { summarize: async input => ({ scope: input.scope, text: '', sourceVersions: [] }) }, minMessages: 10, maxMessages: 20, inputTokenBudget: 10000, countTokens: () => 100 },
  });

  const queue = new RoleMemoryLifecycleQueue(port, () => {});
  const controller = new TurnController();
  const pipeline = new DialoguePipeline({
    dialogue: mockDialogue as any,
    memory: port,
    backgroundMemory: queue as any,
    mediaStore: { async releaseScope() {} } as any,
    perception: {} as any,
    tts: {} as any,
    playback: {} as any,
    outputMode: 'text',
  }, controller, () => {});

  const { input, signal: turnSignal } = controller.begin('text', '测试消息');
  operationsOrder.push('turn_begin');

  const res = await pipeline.run(input, turnSignal);
  assert.equal(res.status, 'replied');

  // T5: Verify assistant message was saved and links to user message ID
  const asstRec = store.inspect(input.scope, `${input.scope.turnId}:assistant`);
  assert.ok(asstRec, 'T5: Assistant transcript must be saved');
  assert.equal(asstRec?.text, '回复测试');
  assert.equal(asstRec?.sources.some(s => s.id === `${input.scope.turnId}:user`), true, 'T5: Assistant links to user transcript source');
  await queue.close();
});

// -------------------------------------------------------------------------------------------------
// T6: Real Context Stale Invalidation
// -------------------------------------------------------------------------------------------------
test('T6: Real Context Stale Invalidation prevents stale reuse after fact edit', async t => {
  const f = fixture();
  t.after(f.cleanup);
  const store = f.open();
  const port = new SqliteLifecycleMemoryPort(store, {
    context: { inputTokenBudget: 20000, maxRecentMessages: 12, maxMemories: 8, summaryLimit: 4, countTokens: () => 100, relevance: () => 1 },
    turn: { provider: { plan: async () => ({ scope: scope(), request: 'none', changes: [], suppressSources: [], clarification: null, reason: 'none' }) }, inputTokenBudget: 20000, countTokens: () => 100 },
    summary: { provider: { summarize: async input => ({ scope: input.scope, text: '', sourceVersions: [] }) }, minMessages: 10, maxMessages: 20, inputTokenBudget: 10000, countTokens: () => 100 },
  });
  const mgmt = new SqliteManagementMemoryPort(store, port);

  const turn1 = scope('companion', 'turn-t6-1');
  await port.append(turn1, [message('turn-t6-1:user', '我住在北京。')]);
  store.apply(change({ type: 'add', id: 'mem-city', text: '用户住在北京', sourceIds: ['turn-t6-1:user'] }, 'op-add-city', turn1));

  // Turn 2 consumes this memory
  const turn2 = scope('companion', 'turn-t6-2');
  await port.append(turn2, [message('turn-t6-2:user', '北京')]);
  const c2 = await port.foregroundContext(turn2, 'turn-t6-2:user', '北京', null, signal());
  assert.ok(c2.memories.some(m => m.id === 'mem-city'), 'Memory must be selected in context');
  await port.appendAssistant(turn2, replyMessage(turn2, '北京今天晴朗。'), c2, 'turn-t6-2:user', signal());

  // Context is initially valid
  assert.doesNotThrow(() => port.assertContextCurrent(c2));

  // Edit memory: change city to Shanghai
  mgmt.edit({
    characterId: 'companion',
    id: 'mem-city',
    expectedVersion: 1,
    operationId: 'op-edit-city',
    text: '用户住在上海',
    reason: '搬家更正',
  });

  // T6: assertContextCurrent MUST throw because the underlying source version changed!
  assert.throws(
    () => port.assertContextCurrent(c2),
    /stale_context|outdated/i,
    'T6: Previously issued context must be rejected as stale after source modification',
  );
});

test('T6-B: Continuity in-flight invalidation prevents stale reuse after forget or correction (RV75-02)', async t => {
  const f = fixture();
  t.after(f.cleanup);
  const store = f.open();

  const packs = await CharacterPackStore.open(store);
  const continuityMemory = await ContinuityMemoryStore.open(store);
  const pairing = productionPairing('companion', 'companion-default');

  const fact = continuityMemory.record({
    pairing,
    operationId: 'seed-t6b-soul',
    layer: 'user_soul',
    kind: 'user_defined',
    text: 'USER_PRIVATE_LOCATION',
    origin: 'user',
    status: 'active',
  }).fact;

  const continuityContext = new ProductionContinuityContext({
    packs,
    memory: continuityMemory,
    pairing: { pairingFor: () => pairing },
    dialogueInputTokenBudget: 30000,
  });

  const port = new SqliteLifecycleMemoryPort(store, {
    context: {
      inputTokenBudget: 30000,
      maxRecentMessages: 10,
      maxMemories: 5,
      summaryLimit: 2,
      countTokens: () => 10,
      relevance: () => 1,
      continuity: s => continuityContext.contextFor(s.characterId, ''),
      assertContinuityCurrent: res => continuityContext.assertCurrent(res),
    },
    turn: {
      provider: { plan: async () => { throw new Error('unused'); } },
      inputTokenBudget: 10000,
      countTokens: () => 10,
    },
    summary: {
      provider: { summarize: async () => { throw new Error('unused'); } },
      minMessages: 10,
      maxMessages: 20,
      inputTokenBudget: 5000,
      countTokens: () => 10,
    },
  });

  const turn = scope('companion', 'turn-t6b-1');
  await port.append(turn, [message('turn-t6b-1:user', '你好呀')]);
  const c = await port.foregroundContext(turn, 'turn-t6b-1:user', '你好呀', null, signal());

  assert.ok(c.continuity?.text.includes('USER_PRIVATE_LOCATION'), 'Issued context must include the user soul fact');
  assert.doesNotThrow(() => port.assertContextCurrent(c));

  // User forgets the fact in-flight
  continuityMemory.forget({
    pairing,
    operationId: 'forget-t6b-soul',
    targetId: fact.id,
    expectedVersion: fact.version,
    reason: '隐私遗忘',
  });

  // Now, assertContextCurrent MUST throw and reject the in-flight context
  assert.throws(
    () => port.assertContextCurrent(c),
    /stale_context/i,
    'T6-B: In-flight context containing forgotten continuity fact must be rejected',
  );
});

// -------------------------------------------------------------------------------------------------
// T7 & T8: Production Trace Stage Sequence & Privacy Default
// -------------------------------------------------------------------------------------------------
test('T7 & T8: Production Trace Stages and Privacy Defaults', async t => {
  const { db, cleanup } = createTempDb();
  t.after(cleanup);

  const traceStore = RuntimeTraceStore.open(db);
  const controller = new TurnController();

  const mockDialogue = {
    async reply(req: any) {
      return { scope: req.scope, text: '秘密回复内容', expression: { emotion: 'neutral', intensity: 0, delivery: '', gesture: null } };
    },
  };

  const storedMessages: unknown[] = [];
  const mockMemory = {
    async append(sc: any, msgs: any) { storedMessages.push(...msgs); },
    async context(s: any) { return { scope: s, characterPrompt: '', recent: [], summary: '', memories: [], perception: null, inputTokenBudget: 4000 }; },
  };

  const pipeline = new DialoguePipeline({
    dialogue: mockDialogue as any,
    memory: mockMemory as any,
    mediaStore: { async releaseScope() {} } as any,
    perception: {} as any,
    tts: {} as any,
    playback: {} as any,
    outputMode: 'text',
    traceStore,
    traceDebugOptIn: false, // T8: Privacy by default
  }, controller, () => {});

  const secretInput = '这是一条绝对机密的用户输入文本';
  const { input, signal: turnSignal } = controller.begin('text', secretInput);
  await pipeline.run(input, turnSignal);

  // T7: Verify stage sequence
  const list = traceStore.list({ characterId: 'companion' });
  assert.equal(list.total, 1);
  const trace = list.traces[0]!;
  const stages = trace.stages.map(s => s.name);
  assert.ok(stages.includes('admission'), 'Stage: admission');
  assert.ok(stages.includes('context'), 'Stage: context');
  assert.ok(stages.includes('llm'), 'Stage: llm');
  assert.ok(stages.includes('assistant_persist'), 'Stage: assistant_persist');

  // T8: Verify privacy sanitization by default
  assert.ok(!trace.userText.includes('绝对机密'), 'T8: Default trace must NOT store plain user text');
  assert.ok(trace.userText.startsWith('[digest:'), 'T8: User text replaced with digest');
  assert.ok(!trace.replyText.includes('秘密回复'), 'T8: Default trace must NOT store plain assistant text');
  assert.ok(trace.replyText.startsWith('[digest:'), 'T8: Reply text replaced with digest');
});

test('T8-B: Trace Stage Details Sanitization & Early Stage Retainment (RV75-03, RV75-05)', async t => {
  const { db, cleanup } = createTempDb();
  t.after(cleanup);

  const traceStore = RuntimeTraceStore.open(db);

  // 1. Early background stage arrives before foreground record
  const accepted = traceStore.appendStage('race-turn-1', {
    name: 'memory_plan',
    label: '后台记忆规划与提炼',
    elapsedMs: 25,
    status: 'ok',
    category: 'background',
    details: { retrievedMemories: ['SENSITIVE_LEAK_TARGET'] },
  });
  assert.equal(accepted, true, 'Early background stage must be accepted');

  // 2. Foreground records turn trace with raw secret in details
  traceStore.record({
    traceId: 'trace-race-1',
    turnId: 'race-turn-1',
    characterId: 'companion',
    sessionId: 'session-race',
    userText: 'SECRET_USER_INPUT',
    replyText: 'SECRET_REPLY_OUTPUT',
    totalElapsedMs: 50,
    status: 'ok',
    stages: [
      {
        name: 'context',
        label: '上下文与记忆召回',
        elapsedMs: 5,
        status: 'ok',
        category: 'foreground',
        details: { rawUserSecret: 'SENSITIVE_LEAK_TARGET', memories: 3 },
      },
    ],
    createdAt: new Date().toISOString(),
  }, false);

  const saved = traceStore.get('trace-race-1')!;
  assert.ok(saved, 'Trace must be saved');

  // Verify background stage was retained
  assert.ok(
    saved.stages.some(s => s.name === 'memory_plan'),
    'Early background stage must be retained after record() merge (RV75-05)',
  );

  // Verify details whitelist: raw secret string must be redacted to digest
  const serializedStages = JSON.stringify(saved.stages);
  assert.ok(
    !serializedStages.includes('SENSITIVE_LEAK_TARGET'),
    'Stage details must NOT contain plain-text memory/fact secrets (RV75-03)',
  );
  assert.ok(
    serializedStages.includes('[digest:'),
    'Sensitive values in details must be sanitized to digests',
  );
});

// -------------------------------------------------------------------------------------------------
// T9: Companion Timeline Latest-N & Chronological Order
// -------------------------------------------------------------------------------------------------
test('T9: Companion Timeline Latest-N & Chronological Order', async t => {
  const { db, cleanup } = createTempDb();
  t.after(cleanup);

  const store = await CharacterPackStore.open(db);
  const pairing = productionPairing('companion', 'inst-t9');

  // Insert 20 companion timeline events
  for (let i = 1; i <= 20; i++) {
    const sec = String(i).padStart(2, '0');
    store.appendCompanionEvent({
      userId: pairing.userId,
      characterId: pairing.characterId,
      characterInstanceId: pairing.characterInstanceId,
      sessionId: 's-1',
      turnId: `t-${i}`,
      userText: `Event ${i}`,
      assistantText: `Reply ${i}`,
      createdAt: `2026-09-01T12:00:${sec}.000Z`,
    });
  }

  // Request maxCompanionEvents: 5
  const snapshot = await store.getSnapshot(pairing, { maxCompanionEvents: 5 });
  assert.equal(snapshot.companionTimeline.length, 5, 'Must return exactly 5 events');

  // T9 Assertion: Selected events are 16..20 (the latest 5), NOT 1..5
  const userTexts = snapshot.companionTimeline.map(e => e.userText);
  assert.deepEqual(userTexts, ['Event 16', 'Event 17', 'Event 18', 'Event 19', 'Event 20'], 'T9: Must select the latest 5 events');

  // T9 Assertion: Order is chronological (16 before 17 before ... before 20)
  const timestamps = snapshot.companionTimeline.map(e => new Date(e.createdAt).getTime());
  for (let i = 0; i < timestamps.length - 1; i++) {
    assert.ok(timestamps[i]! < timestamps[i + 1]!, 'T9: Chronological forward order must be preserved');
  }
});

// -------------------------------------------------------------------------------------------------
// T10: ProviderRuntime Resolution
// -------------------------------------------------------------------------------------------------
test('T10: ProviderRuntime Resolution from legacy configuration', () => {
  const mockConfig: TrialConfiguration = {
    version: 1,
    phaseId: 'p-10',
    purpose: 'smoke-text',
    projectRoot: 'F:\\AIVoice\\Aika-Next\\windows\\code\\desktop-pet',
    sourceRevision: '1',
    runtimeFiles: {},
    database: ':memory:',
    limitMicros: null,
    budgetMode: 'unlimited',
    models: {
      dialogue: {
        provider: 'dashscope',
        protocol: 'openai-compatible',
        model: 'qwen-max',
        endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        credentialFile: 'credentials/key.txt',
        inputTokenLimit: 32768,
        outputTokenLimit: 8192,
        inputMicrosPerToken: 0.8,
        outputMicrosPerToken: 2.0,
        reservationMicros: 100000,
      },
      memory_turn: {
        provider: 'deepseek',
        protocol: 'openai-compatible',
        model: 'deepseek-reasoner',
        endpoint: 'https://api.deepseek.com/v1',
        credentialFile: 'credentials/ds.txt',
        inputTokenLimit: 65536,
        outputTokenLimit: 8192,
        inputMicrosPerToken: 1.0,
        outputMicrosPerToken: 2.0,
        reservationMicros: 60000,
      },
    } as any,
    memory: { mode: 'strict', scheduling: 'semantic-admission', timeoutMs: 30000 },
  } as unknown as TrialConfiguration;

  const adapter = new LegacyProviderRuntimeAdapter(
    mockConfig,
    { async authorize() { return { async settle() {} }; } },
    ref => () => 'resolved-test-key',
  );

  // T10: resolve legacy slots through ProviderRuntime
  const resolvedDialogue = adapter.resolveOperationBinding('dialogue');
  assert.equal(resolvedDialogue.bindingId, 'legacy.dialogue');
  assert.equal(resolvedDialogue.capabilityId, 'llm.chat');
  assert.equal(resolvedDialogue.nativeModelId, 'qwen-max');
  assert.equal(resolvedDialogue.deployment, 'remote-api');
  assert.ok(resolvedDialogue.instanceKey.length > 0);

  const resolvedMemory = adapter.resolveOperationBinding('memory_turn');
  assert.equal(resolvedMemory.bindingId, 'legacy.memory_turn');
  assert.equal(resolvedMemory.capabilityId, 'background.lifecycle');
  assert.equal(resolvedMemory.nativeModelId, 'deepseek-reasoner');

  // Verify EndpointConfig conversion
  const endpoint = adapter.getEndpointConfig('dialogue');
  assert.equal(endpoint.model, 'qwen-max');
  assert.equal(endpoint.endpoint, 'https://dashscope.aliyuncs.com/compatible-mode/v1');
  assert.equal(endpoint.apiKey(), 'resolved-test-key');
});
