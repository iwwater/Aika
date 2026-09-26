import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { ContinuityMemoryStore, ContinuityMemoryError } from '../../memory/continuity-memory-store.js';
import { ConversationCandidateWriter } from '../../memory/conversation-candidate-writer.js';
import { CharacterPackStore } from '../../memory/character-pack-store.js';
import { CharacterDistiller } from '../../providers/character-distiller.js';
import { createSourceSnapshot } from '../../memory/character-pack-source.js';
import { computeCutoffAllowedBlockIds } from '../../memory/character-pack-validator.js';
import { DEFAULT_SOURCE_LIMITS } from '../../contracts/character-pack.js';
import { ProviderTransport, type EndpointConfig, type JsonRecord, type ProviderOperation } from '../../providers/transport.js';
import type { ConversationMessage, DialogueContext, TurnScope } from '../../contracts/index.js';
import { LocalGreetingScheduler, localGreetingBand } from '../../desktop/local-greeting.js';
import { BackendSession } from '../../app/backend-session.js';
import { MemoryMediaStore } from '../../media/store.js';
import { ProductionContinuityContext } from '../../memory/continuity-production.js';
import { fixture as historyFixture } from '../memory/sqlite-fixture.js';

const pairing = { userId: 'local-user', characterId: 'companion', characterInstanceId: 'inst-079' } as const;

class StubTransport extends ProviderTransport {
  constructor(private readonly text: string) { super(); }
  override async request(_config: EndpointConfig, _scope: TurnScope, _operation: ProviderOperation, _body: JsonRecord, _signal: AbortSignal): Promise<JsonRecord> {
    return { text: this.text };
  }
}

test('N079-01 invalidates a derived closure after root forget and correction', async t => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  const store = await ContinuityMemoryStore.open(db);
  const root = store.record({ pairing, operationId: 'root', layer: 'user_wiki', kind: 'fact', text: '根事实', origin: 'user', status: 'active', sourceIds: ['chat-1'] });
  const lease = store.beginDerived(pairing);
  const derived = store.commitDerived({ lease, operationId: 'derived', layer: 'user_soul', kind: 'inference', text: '派生事实', sourceIds: [root.fact.id], status: 'active' });
  const childLease = store.beginDerived(pairing);
  const child = store.commitDerived({ lease: childLease, operationId: 'derived-child', layer: 'user_soul', kind: 'inference', text: '二级派生事实', sourceIds: [derived.fact.id], status: 'active' });
  assert.equal(store.snapshot(pairing).soul.length, 2);
  store.forget({ pairing, operationId: 'forget-root', targetId: root.fact.id, expectedVersion: root.fact.version, reason: '用户要求遗忘' });
  assert.equal(store.snapshot(pairing).soul.length, 0);
  assert.throws(() => store.record({ pairing, operationId: 'resurrect', layer: 'user_soul', kind: 'inference', text: '不能复活', origin: 'derived', sourceIds: [child.fact.id], status: 'active' }), (error: unknown) => error instanceof ContinuityMemoryError && error.code === 'version_conflict');

  const correctedRoot = store.record({ pairing, operationId: 'root-2', layer: 'user_wiki', kind: 'fact', text: '第二个根事实', origin: 'user', status: 'active', sourceIds: ['chat-2'] });
  const lease2 = store.beginDerived(pairing);
  store.commitDerived({ lease: lease2, operationId: 'derived-2', layer: 'user_soul', kind: 'inference', text: '第二个派生', sourceIds: [correctedRoot.fact.id], status: 'active' });
  store.correct({ pairing, operationId: 'correct-root-2', targetId: correctedRoot.fact.id, expectedVersion: correctedRoot.fact.version, text: '修正后的根事实', reason: '用户纠正' });
  assert.equal(store.snapshot(pairing).soul.length, 0);
});

test('N079-01 an old idempotency receipt cannot reveal a forgotten fact, including after restart', async t => {
  const f = historyFixture(300_000_000, 'next079-forgotten-operation-replay');
  t.after(() => f.cleanup());
  let history = f.open();
  let store = await ContinuityMemoryStore.open(history);
  const original = { pairing, operationId: 'receipt-root', layer: 'user_wiki' as const, kind: 'fact' as const,
    text: '用户要求忘记的合成内容', origin: 'user' as const, status: 'active' as const };
  const created = store.record(original);
  const forget = { pairing, operationId: 'forget-receipt-root', targetId: created.fact.id,
    expectedVersion: created.fact.version, reason: '自动化验收' };
  assert.equal(store.forget(forget).fact.text, '');
  assert.equal(store.forget(forget).fact.text, '', 'forget remains idempotent without replaying its old body');

  const staleReceipt = (error: unknown) => error instanceof ContinuityMemoryError && error.code === 'version_conflict';
  assert.throws(() => store.record(original), staleReceipt);
  history.close();
  history = f.open();
  store = await ContinuityMemoryStore.open(history);
  assert.throws(() => store.record(original), staleReceipt);
  assert.equal(store.forget(forget).fact.text, '', 'a repeated forget after restart only returns the scrubbed row');
  assert.equal(store.snapshot(pairing).wiki.length, 0);
});

test('N079-01 a stale derived lease stays rejected after restart without invalidating another pairing', async t => {
  const f = historyFixture(300_000_000, 'next079-stale-lease-restart');
  t.after(() => f.cleanup());
  const otherPair = { ...pairing, characterInstanceId: 'inst-079-other' } as const;
  let history = f.open();
  let store = await ContinuityMemoryStore.open(history);
  const rootA = store.record({ pairing, operationId: 'lease-root-a', layer: 'user_wiki', kind: 'fact', text: 'A 根事实', origin: 'user', status: 'active' });
  const rootB = store.record({ pairing: otherPair, operationId: 'lease-root-b', layer: 'user_wiki', kind: 'fact', text: 'B 根事实', origin: 'user', status: 'active' });
  const staleA = store.beginDerived(pairing);
  const unaffectedB = store.beginDerived(otherPair);
  store.forget({ pairing, operationId: 'lease-forget-a', targetId: rootA.fact.id, expectedVersion: rootA.fact.version, reason: '撤销 A 来源' });
  history.close();

  history = f.open();
  store = await ContinuityMemoryStore.open(history);
  assert.throws(() => store.commitDerived({ lease: staleA, operationId: 'stale-after-restart', layer: 'user_soul', kind: 'inference', text: '不得写入', sourceIds: [rootA.fact.id] }),
    (error: unknown) => error instanceof ContinuityMemoryError && error.code === 'version_conflict');
  assert.equal(store.commitDerived({ lease: unaffectedB, operationId: 'other-pair-still-current', layer: 'user_soul', kind: 'inference', text: 'B 的有效派生', sourceIds: [rootB.fact.id] }).status, 'applied');

  const replacementA = store.record({ pairing, operationId: 'lease-root-a-replacement', layer: 'user_wiki', kind: 'fact', text: '新的 A 根事实', origin: 'user', status: 'active' });
  const freshA = store.beginDerived(pairing);
  assert.equal(store.commitDerived({ lease: freshA, operationId: 'fresh-after-restart', layer: 'user_soul', kind: 'inference', text: '新的有效派生', sourceIds: [replacementA.fact.id] }).status, 'applied');
});

test('N079-01 preserves local distillation metadata and rejects an unknown cutoff', async () => {
  const source = createSourceSnapshot('src-079', 'companion', { sourceName: 'story.txt', text: '第一章\n\n沈砚住在临海城。\n\n第二章\n\n他离开。' });
  const model = JSON.stringify({ schemaVersion: '0.7-draft-1', character: { name: '沈砚', soul: '稳重' }, canonFacts: [{ id: 'f-1', text: '沈砚住在临海城。', status: 'explicit', evidenceIds: [source.blocks[0]!.id] }], gaps: [] });
  const config = { endpoint: 'https://example.invalid', model: 'stub', apiKey: () => 'key', authorizer: { async authorize() { return { async settle() {} }; } } };
  const distiller = new CharacterDistiller(config, { transport: new StubTransport(model) });
  const valid = await distiller.distill({ characterId: 'companion', sources: [source], cutoffPoint: '第一章', workTitle: '临海城' }, new AbortController().signal);
  assert.equal(valid.status, 'validated');
  assert.equal(valid.payload.cutoffPoint, '第一章');
  assert.equal(valid.payload.workTitle, '临海城');
  const unknown = await distiller.distill({ characterId: 'companion', sources: [source], cutoffPoint: '不存在的章节' }, new AbortController().signal);
  assert.equal(unknown.status, 'rejected');
  assert.ok(unknown.validation.errors.some(error => error.includes('未能在来源区块中定位')));
});

test('N079-01 cutoff includes every Unicode-split block through the named chapter across sources', () => {
  const limits = { ...DEFAULT_SOURCE_LIMITS, maxBlockCodePoints: 5 };
  const make = (id: string, first: string, last: string) => createSourceSnapshot(id, 'companion', {
    sourceName: `${id}.md`,
    text: `# 第一章 ${first}\n\n前置😀内容\n\n# 第二章 愿望🌙\n\n这一章节拆成很多个 Unicode 区块🙂，全部应保留。\n\n# 第三章 ${last}\n\n截止点之后。`,
  }, new Date(0).toISOString(), limits);
  const sources = [make('cutoff-a', '起点', '旅程'), make('cutoff-b', '再会', '远方')];
  const allowed = computeCutoffAllowedBlockIds(sources, '第二章 愿望🌙');
  const expected = sources.flatMap(source => {
    const matching = source.blocks.flatMap((block, index) => block.locator.chapter === '第二章 愿望🌙' ? [index] : []);
    const end = matching.at(-1) ?? -1;
    assert.ok(end >= 0, 'the Unicode chapter heading is preserved in block locators');
    return source.blocks.slice(0, end + 1).map(block => block.id);
  }).sort();
  assert.deepEqual([...allowed].sort(), expected, 'all prior and full cutoff-chapter blocks are allowed, later chapters are excluded');
});

test('N079-08 companion projection is idempotent and does not overwrite a divergent replay', async t => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  const store = await CharacterPackStore.open(db);
  const event = { eventId: 'cte-turn-1', userId: pairing.userId, characterId: pairing.characterId, characterInstanceId: pairing.characterInstanceId, sessionId: 's-1', turnId: 'turn-1', userText: '你好', assistantText: '我在。', createdAt: '2026-09-23T08:00:00.000Z' };
  const first = store.appendCompanionEvent(event);
  const replay = store.appendCompanionEvent(event);
  assert.equal(replay.eventId, first.eventId);
  assert.equal((await store.getSnapshot(pairing)).companionTimeline.length, 1);
  assert.throws(() => store.appendCompanionEvent({ ...event, assistantText: '另一份回复' }));
  assert.equal((await store.getSnapshot(pairing)).companionTimeline[0]!.assistantText, '我在。');
});

test('N079-07 local greetings are local, rate-limited and never queued behind busy work', () => {
  let now = new Date(2026, 0, 1, 9, 0).getTime();
  const scheduler = new LocalGreetingScheduler({ now: () => now, idleAfterMs: 45 * 60 * 1000, cooldownMs: 6 * 60 * 60 * 1000 });
  now += 45 * 60 * 1000;
  const first = scheduler.tick({ now, busy: false, visible: true });
  assert.equal(first?.band, 'morning');
  assert.match(first?.text ?? '', /早上好/);
  scheduler.markInteraction(now);
  let busyNow = now;
  const busyScheduler = new LocalGreetingScheduler({ now: () => busyNow, idleAfterMs: 100, cooldownMs: 0 });
  busyNow += 100;
  assert.equal(busyScheduler.tick({ now: busyNow, busy: true, visible: true }), null);
  busyNow += 1;
  assert.equal(busyScheduler.tick({ now: busyNow, busy: false, visible: true }), null, 'the busy due prompt is not queued');
  now += 60 * 60 * 1000;
  assert.equal(scheduler.tick({ now, busy: false, visible: true }), null, 'cooldown prevents a second local prompt');
  assert.equal(localGreetingBand(new Date(2026, 0, 1, 23, 30)), 'night');
  // S3 (ACCEPT-02): instant preview when toggled on
  assert.equal(localGreetingBand(new Date(2026, 0, 1, 8, 0)), 'morning');
  assert.equal(localGreetingBand(new Date(2026, 0, 1, 14, 0)), 'day');
  assert.equal(localGreetingBand(new Date(2026, 0, 1, 19, 0)), 'evening');
  assert.equal(localGreetingBand(new Date(2026, 0, 1, 2, 0)), 'night');

  const previewScheduler = new LocalGreetingScheduler({ now: () => now, idleAfterMs: 45 * 60 * 1000, cooldownMs: 6 * 60 * 60 * 1000 });
  const previewMorning = previewScheduler.preview({ now: new Date(2026, 0, 1, 8, 30).getTime() });
  assert.equal(previewMorning?.band, 'morning');
  assert.match(previewMorning?.text ?? '', /早上好/);

  const previewDay = previewScheduler.preview({ now: new Date(2026, 0, 1, 13, 0).getTime() });
  assert.equal(previewDay?.band, 'day');
  assert.match(previewDay?.text ?? '', /留一点喘气/);

  const previewEvening = previewScheduler.preview({ now: new Date(2026, 0, 1, 20, 0).getTime() });
  assert.equal(previewEvening?.band, 'evening');
  assert.match(previewEvening?.text ?? '', /晚上好/);

  const previewNight = previewScheduler.preview({ now: new Date(2026, 0, 1, 1, 0).getTime() });
  assert.equal(previewNight?.band, 'night');
  assert.match(previewNight?.text ?? '', /还没睡呀/);

  assert.equal(previewScheduler.preview({ busy: true }), null, 'busy state suppresses preview');
  previewScheduler.setEnabled(false);
  assert.equal(previewScheduler.preview({ busy: false }), null, 'disabled scheduler suppresses preview');
  previewScheduler.setEnabled(true);

  // Preview must not consume normal 45min automatic tick
  let autoNow = new Date(2026, 0, 1, 10, 0).getTime();
  const autoScheduler = new LocalGreetingScheduler({ now: () => autoNow, idleAfterMs: 45 * 60 * 1000, cooldownMs: 6 * 60 * 60 * 1000 });
  // Fire a preview immediately
  const p = autoScheduler.preview({ now: autoNow });
  assert.ok(p);
  // Advance 45 mins idle - tick should still fire normally
  autoNow += 45 * 60 * 1000;
  const autoTick = autoScheduler.tick({ now: autoNow, busy: false, visible: true });
  assert.ok(autoTick, 'preview did not consume automatic tick or its cooldown');

  const restartScheduler = new LocalGreetingScheduler({ now: () => now, idleAfterMs: 0, cooldownMs: 6 * 60 * 60 * 1000, lastShownAt: now - 60 * 60 * 1000 });
  assert.equal(restartScheduler.tick({ now, busy: false, visible: true }), null, 'persisted cooldown survives a renderer restart');
  now += 7 * 60 * 60 * 1000;
  assert.ok(restartScheduler.tick({ now, busy: false, visible: true }), 'greeting can resume after persisted cooldown');
  scheduler.setEnabled(false);
  now += 12 * 60 * 60 * 1000;
  assert.equal(scheduler.tick({ now, busy: false, visible: true }), null);
});

test('N079-08 production turn stages an ID-only outbox, recovers it after restart, and reads it in the next Context', async t => {
  const f = historyFixture(300_000_000, 'next079-projection');
  t.after(() => f.cleanup());
  f.setTime(new Date().toISOString());
  let history = f.open();
  let packs = await CharacterPackStore.open(history);
  let continuity = await ContinuityMemoryStore.open(history);
  let candidates = new ConversationCandidateWriter(history, continuity, () => pairing);
  candidates.initialize(pairing);
  const stored: string[] = [];
  let savedScope: TurnScope | undefined;
  const projectHook = (scope: TurnScope) => {
    savedScope = scope;
    packs.stageCompanionProjection({ pairing, sessionId: scope.sessionId, turnId: scope.turnId, createdAt: '2026-09-23T08:00:00.000Z' });
    candidates.afterConversationSaved(scope);
  };
  const session = new BackendSession({
    outputMode: 'text', mediaStore: new MemoryMediaStore(),
    perception: { async perceive() { throw Error('Text input must not capture or perceive'); } },
    tts: { async synthesize() { throw Error('Text input must not synthesize speech'); } },
    memory: {
      async append(scope: TurnScope, messages: readonly ConversationMessage[]) {
        history.append(scope, messages);
        stored.push(...messages.map(message => `${message.role}:${message.text}`));
      },
      async context(scope: TurnScope): Promise<DialogueContext> { return { scope, characterPrompt: 'test', recent: [], summary: '', memories: [], perception: null, inputTokenBudget: 1000 }; },
      maintenanceInput(scope: TurnScope) { return { scope, messages: [], relevantMemories: [] }; },
      async maintain() { return []; },
    } as any,
    dialogue: { async reply(input) { return { scope: input.scope, text: '我在。', expression: { emotion: 'neutral', intensity: 0, delivery: '', gesture: null } }; } },
    onConversationSaved: projectHook,
  }, () => {}, () => {});
  await session.receiveLine(JSON.stringify({ channel: 'command', command: { type: 'submit_text', text: '我喜欢徒步。' } }));
  await session.drain();
  assert.ok(savedScope, 'BackendSession must invoke the public saved-conversation callback after persistence');
  assert.deepEqual(stored, ['user:我喜欢徒步。', 'assistant:我在。']);
  const turnCandidates = continuity.snapshot(pairing, { includeCandidates: true }).candidates;
  assert.equal(turnCandidates.length, 1, 'the ordinary production turn callback must create a review candidate');
  assert.equal(turnCandidates[0]!.text, '我喜欢徒步。');
  assert.deepEqual(turnCandidates[0]!.sourceIds, [`history:${savedScope!.turnId}:user`]);
  assert.equal(continuity.snapshot(pairing).wiki.length, 0, 'saved conversation cannot auto-promote a candidate');
  assert.equal((history.rawDatabaseForKnowledge().prepare('SELECT COUNT(*) AS count FROM character_companion_projection_outbox').get() as {count:number}).count, 1);
  assert.equal((await packs.getSnapshot(pairing)).companionTimeline.length, 0, 'the staged row must not contain or expose a second transcript before projection');
  await session.close();

  // Model process restart between durable History commit and asynchronous Timeline projection.
  history.close();
  history = f.open();
  packs = await CharacterPackStore.open(history);
  continuity = await ContinuityMemoryStore.open(history);
  candidates = new ConversationCandidateWriter(history, continuity, () => pairing);
  candidates.initialize(pairing);
  candidates.recover(pairing);
  assert.equal(continuity.snapshot(pairing, { includeCandidates: true }).candidates.length, 1, 'review state survives process restart');
  assert.deepEqual(packs.projectPendingCompanionEvents(() => { throw Error('transient History read failure'); }), { projected: 0, discarded: 0, pending: 1 }, 'transient failures keep the durable outbox marker');
  const recovered = packs.projectPendingCompanionEvents((scope, id) => {
    const record = history.inspect({ ...scope, generation: 0 }, id);
    return record ? { state: record.state, role: record.message?.role, text: record.message?.text } : null;
  });
  assert.deepEqual(recovered, { projected: 1, discarded: 0, pending: 0 });
  assert.deepEqual(packs.projectPendingCompanionEvents(() => null), { projected: 0, discarded: 0, pending: 0 });
  const productionContext = new ProductionContinuityContext({ packs, memory: continuity, pairing: { pairingFor: () => pairing }, dialogueInputTokenBudget: 4096 });
  const next = await productionContext.contextFor('companion', '徒步');
  assert.ok(next?.segments.some(segment => segment.source === 'companion_timeline' && segment.text.includes('徒步') && segment.text.includes('我在。')));
  const savedContext = next!;
  f.setTime(new Date(Date.now() + 31 * 24 * 60 * 60 * 1000).toISOString());
  history.cleanup();
  assert.equal(continuity.snapshot(pairing, { includeCandidates: true }).candidates.length, 0, 'expired History source is revoked from candidate review');
  const redacted = history.rawDatabaseForKnowledge().prepare('SELECT user_text,assistant_text FROM character_companion_timeline WHERE event_id=?').get(`cte-turn-${savedScope!.turnId}`) as {user_text:string;assistant_text:string};
  assert.deepEqual(redacted, { user_text: '', assistant_text: '' }, 'History expiry scrubs the Companion Timeline duplicate in the same SQLite transaction');
  assert.equal((await packs.getSnapshot(pairing)).companionTimeline.length, 0, 'expired History sources must suppress the duplicate Timeline event');
  assert.throws(() => productionContext.assertCurrent(savedContext), /Context|失效|stale/i, 'an in-flight Context cannot retain an expired Timeline source');
});
