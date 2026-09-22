import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, scope, message } from './sqlite-fixture.js';
import { lifecycle, signal, replyMessage } from './lifecycle-fixture.js';
import { CharacterPackStore } from '../../memory/character-pack-store.js';
import { ContinuityMemoryStore } from '../../memory/continuity-memory-store.js';
import { ProductionContinuityContext } from '../../memory/continuity-production.js';
import { productionPairing } from '../../contracts/character-pack.js';
import { JsonDialogueProvider } from '../../providers/qwen-dialogue.js';
import { ProviderTransport, type EndpointConfig } from '../../providers/transport.js';

test('N075-01 R2: continuity sources compose into production DialogueContext and reach Dialogue LLM', async t => {
  const f = fixture();
  t.after(f.cleanup);
  const store = f.open();

  // 1. Open the two continuity stores on the SAME SQLite store
  const packs = await CharacterPackStore.open(store);
  const contStore = await ContinuityMemoryStore.open(store);

  const pairing = productionPairing('companion', 'inst-main');

  // 2. Seed a Character Pack with soul & canon facts & canon timeline
  const src = await packs.importSource('companion', {
    sourceName: 'canon-ch1.txt',
    text: '沈砚在临海城生活。第三年遭遇寒潮。',
  });
  const draft = await packs.saveDraft({
    characterId: 'companion',
    payload: {
      schemaVersion: '0.7-draft-1',
      character: { name: '沈砚', soul: '重诺守信的观察者' },
      canonFacts: [
        { id: 'cf-1', text: '沈砚在临海城生活。', status: 'explicit', evidenceIds: [src.snapshot.blocks[0]!.id] },
        { id: 'cf-2', text: '第三年遭遇寒潮。', status: 'explicit', evidenceIds: [src.snapshot.blocks[0]!.id] },
      ],
      gaps: [],
    },
    sourceIds: [src.snapshot.id],
    validation: { valid: true, errors: [], validatedAt: new Date().toISOString() },
  });
  await packs.activateDraft({
    characterId: 'companion',
    draftId: draft.id,
    userId: pairing.userId,
    instanceId: pairing.characterInstanceId,
  });

  // 3. Seed User Soul, User Wiki, Relationship in ContinuityMemoryStore
  contStore.record({
    pairing,
    operationId: 'op-soul-1',
    layer: 'user_soul',
    kind: 'fact',
    text: '用户喜欢喝黑咖啡',
    sourceIds: ['msg-1'],
    origin: 'manual',
    status: 'active',
  });
  contStore.record({
    pairing,
    operationId: 'op-wiki-1',
    layer: 'user_wiki',
    kind: 'fact',
    text: '用户是一名后端架构师',
    sourceIds: ['msg-2'],
    origin: 'manual',
    status: 'active',
  });
  contStore.record({
    pairing,
    operationId: 'op-rel-1',
    layer: 'relationship',
    kind: 'fact',
    text: '沈砚对用户保持尊重与平等的挚友态度',
    sourceIds: ['msg-3'],
    origin: 'manual',
    status: 'active',
  });

  // 4. Seed a companion timeline event
  packs.appendCompanionEvent({
    userId: pairing.userId,
    characterId: pairing.characterId,
    characterInstanceId: pairing.characterInstanceId,
    sessionId: 'session-1',
    turnId: 'turn-old',
    userText: '以后叫我老朱。',
    assistantText: '好的，老朱。',
  });

  // 5. Build ProductionContinuityContext
  const continuityContext = new ProductionContinuityContext({
    packs,
    memory: contStore,
    pairing: { pairingFor: () => pairing },
    dialogueInputTokenBudget: 30000,
  });

  // 6. Build SqliteLifecycleMemoryPort with continuity reader
  const port = lifecycle(store, undefined, undefined, {
    context: {
      inputTokenBudget: 30000,
      maxRecentMessages: 12,
      maxMemories: 8,
      summaryLimit: 4,
      countTokens: (c: unknown, text: string) => JSON.stringify(c).length + text.length,
      relevance: () => 1,
      continuity: scope => continuityContext.contextFor(scope.characterId, ''),
    },
  });

  // 7. Request foregroundContext
  const userScope = scope('companion', 'turn-test');
  await port.append(userScope, [message('turn-test:user', '你还记得我的习惯吗？')]);
  const context = await port.foregroundContext(userScope, 'turn-test:user', '你还记得我的习惯吗？', null, signal());

  // Assert continuity context is populated
  assert.ok(context.continuity, 'context.continuity should be present');
  const sources = new Set(context.continuity.selected.map(item => item.source));
  assert.ok(sources.has('character_soul'), 'character_soul must be selected');
  assert.ok(sources.has('relationship'), 'relationship must be selected');
  assert.ok(sources.has('user_soul'), 'user_soul must be selected');
  assert.ok(sources.has('user_wiki'), 'user_wiki must be selected');
  assert.ok(sources.has('canon_timeline'), 'canon_timeline must be selected');
  assert.ok(sources.has('companion_timeline'), 'companion_timeline must be selected');

  // 8. Pass to JsonDialogueProvider and verify the wire request
  const capturedCalls: unknown[] = [];
  const fakeTransport = new ProviderTransport(async (input, init) => {
    capturedCalls.push(JSON.parse(String(init?.body ?? '{}')));
    return new Response(JSON.stringify({
      choices: [{
        finish_reason: 'stop',
        message: {
          content: JSON.stringify({
            text: '老朱你好，我记得你喜欢黑咖啡。',
            expression: { emotion: 'neutral', intensity: 0.5, delivery: '温和', gesture: null },
          }),
        },
      }],
    }));
  });

  const endpointConfig: EndpointConfig = {
    model: 'mock-model',
    endpoint: 'https://unit.invalid/chat/completions',
    apiKey: () => 'mock-key',
    authorizer: { async authorize() { return { async settle() {} }; } },
  };

  const provider = new JsonDialogueProvider(endpointConfig, fakeTransport);
  const reply = await provider.reply({
    scope: userScope,
    text: '你还记得我的习惯吗？',
    context,
  }, signal());

  assert.equal(capturedCalls.length, 1, 'MUST have exactly ONE Dialogue LLM call');
  assert.ok(reply.text.includes('老朱'), 'Reply text returned from provider');

  const wireBody = capturedCalls[0] as { messages: { role: string; content: string }[] };
  const userPayload = JSON.parse(wireBody.messages.find(m => m.role === 'user')!.content);
  assert.ok(userPayload.continuity, 'Wire payload must contain continuity block');
  assert.ok(userPayload.continuity.includes('重诺守信的观察者'), 'Character soul present in LLM call');
  assert.ok(userPayload.continuity.includes('用户喜欢喝黑咖啡'), 'User soul present in LLM call');
  assert.ok(userPayload.continuity.includes('用户是一名后端架构师'), 'User wiki present in LLM call');
  assert.ok(userPayload.continuity.includes('沈砚对用户保持尊重与平等的挚友态度'), 'Relationship present in LLM call');
  assert.ok(userPayload.continuity.includes('第三年遭遇寒潮'), 'Canon timeline present in LLM call');
  assert.ok(userPayload.continuity.includes('以后叫我老朱'), 'Companion timeline present in LLM call');

  // 9. Privacy isolation: verify that under a pending forget hold, continuity is excluded
  const privacyScope = scope('companion', 'turn-priv');
  await port.append(privacyScope, [message('turn-priv:user', '请忘记我的职业')]);
  port.beginPendingMutation(privacyScope, 'turn-priv:user', { request: 'forget', sources: null });

  const privContext = await port.foregroundContext(privacyScope, 'turn-priv:user', '请忘记我的职业', null, signal());
  assert.equal(privContext.continuity, undefined, 'Privacy excluded context must NOT carry continuity');
});
