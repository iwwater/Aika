// Review-only probes. Run from windows/code/desktop-pet after npm run build.
// Synthetic data only; creates a unique temporary SQLite file, never opens user data.
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
const load = name => import(pathToFileURL(resolve('dist', name)).href);
const { SqliteMemoryStore, CONFIRMED_RETENTION } = await load('memory/sqlite-store.js');
const { confirmedInvitationPolicy } = await load('companion/invitations.js');
const { CharacterPackStore } = await load('memory/character-pack-store.js');
const { ContinuityMemoryStore } = await load('memory/continuity-memory-store.js');
const { ProductionContinuityContext } = await load('memory/continuity-production.js');
const { SqliteLifecycleMemoryPort } = await load('memory/sqlite-lifecycle-port.js');
const { RuntimeTraceStore } = await load('core/trace-store.js');
const store = new SqliteMemoryStore({ filename: join(tmpdir(), `aika-review-${randomUUID()}.sqlite`), retention: CONFIRMED_RETENTION, invitations: confirmedInvitationPolicy('Asia/Shanghai') });
try {
  const packs = await CharacterPackStore.open(store), memory = await ContinuityMemoryStore.open(store);
  const pairing = { userId: 'local-user', characterId: 'companion', characterInstanceId: 'companion-default' };
  const fact = memory.record({ pairing, operationId: 'review-seed', layer: 'user_soul', kind: 'user_defined', text: 'REVIEW_PRIVATE_CITY', origin: 'user', status: 'active' }).fact;
  const production = new ProductionContinuityContext({ packs, memory, pairing: { pairingFor: () => pairing }, dialogueInputTokenBudget: 30000 });
  const port = new SqliteLifecycleMemoryPort(store, {
    context: { inputTokenBudget: 30000, maxRecentMessages: 12, maxMemories: 8, summaryLimit: 4, countTokens: () => 100, relevance: () => 1, continuity: s => production.contextFor(s.characterId, '') },
    turn: { provider: { plan: async () => { throw Error('unused'); } }, inputTokenBudget: 20000, countTokens: () => 100 },
    summary: { provider: { summarize: async () => { throw Error('unused'); } }, minMessages: 10, maxMessages: 20, inputTokenBudget: 10000, countTokens: () => 100 },
  });
  const scope = { characterId: 'companion', sessionId: 'review', turnId: 'review-turn', generation: 1 };
  await port.append(scope, [{ characterId: 'companion', id: 'review-turn:user', role: 'user', text: 'hello', createdAt: new Date().toISOString() }]);
  const context = await port.foregroundContext(scope, 'review-turn:user', 'hello', null, new AbortController().signal);
  memory.forget({ pairing, operationId: 'review-forget', targetId: fact.id, expectedVersion: fact.version, reason: 'review' });
  let rejected = false; try { port.assertContextCurrent(context); } catch { rejected = true; }
  console.log(JSON.stringify({ probe: 'continuity-forget', included: context.continuity?.text.includes('REVIEW_PRIVATE_CITY'), remainingSoul: memory.snapshot(pairing).soul.length, staleRejected: rejected }));
  const traces = RuntimeTraceStore.open(store.rawDatabaseForKnowledge());
  const early = traces.appendStage('race', { name: 'memory_plan', label: 'background', status: 'ok', elapsedMs: 1 });
  traces.record({ traceId: 'trace', turnId: 'race', characterId: 'companion', sessionId: 'review', userText: 'REVIEW_PRIVATE_CITY', replyText: 'ok', totalElapsedMs: 10, status: 'ok', stages: [{ name: 'context', label: 'context', elapsedMs: 1, status: 'ok', details: { retrievedMemories: ['REVIEW_PRIVATE_CITY'] } }], createdAt: new Date().toISOString() });
  const saved = traces.get('trace');
  console.log(JSON.stringify({ probe: 'trace', bodyRedacted: !saved.userText.includes('REVIEW_PRIVATE_CITY'), detailsContainRaw: JSON.stringify(saved.stages).includes('REVIEW_PRIVATE_CITY'), earlyStageAccepted: early, backgroundStageRetained: saved.stages.some(s => s.name === 'memory_plan') }));
} finally { store.close(); }
