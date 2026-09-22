import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { ContinuityMemoryStore, ContinuityMemoryError } from '../../memory/continuity-memory-store.js';
import { CharacterPackStore } from '../../memory/character-pack-store.js';
import type { PairingScope } from '../../contracts/character-pack.js';

const A: PairingScope = { userId: 'u-a', characterId: 'companion', characterInstanceId: 'i-a' };
const B: PairingScope = { userId: 'u-a', characterId: 'companion', characterInstanceId: 'i-b' };

async function fixture() {
  const db = new Database(':memory:');
  const store = await ContinuityMemoryStore.open(db);
  return { db, store };
}

test('N07-04 records pair-scoped Soul/Wiki/relationship facts and rejects unsupported evidence', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const soul = f.store.record({ pairing: A, operationId: 'soul-1', layer: 'user_soul', kind: 'user_defined', text: '用户希望被称为阿航。', origin: 'user', sourceIds: ['conversation:1'], status: 'active' });
  const wiki = f.store.record({ pairing: A, operationId: 'wiki-1', layer: 'user_wiki', kind: 'fact', text: '用户正在做桌宠项目。', origin: 'conversation', sourceIds: ['conversation:2'], status: 'active' });
  const relation = f.store.record({ pairing: A, operationId: 'rel-1', layer: 'relationship', kind: 'milestone', text: '双方约定先区分原作与共同经历。', origin: 'manual', status: 'active' });
  assert.equal(f.store.snapshot(A).soul[0]!.id, soul.fact.id);
  assert.equal(f.store.snapshot(A).wiki[0]!.id, wiki.fact.id);
  assert.equal(f.store.snapshot(A).relationship[0]!.id, relation.fact.id);
  assert.equal(f.store.snapshot(B).soul.length, 0);
  assert.throws(() => f.store.record({ pairing: A, operationId: 'bad-assistant', layer: 'user_wiki', kind: 'fact', text: '助手说我们昨天一起旅行。', origin: 'assistant', status: 'active' }), (error: unknown) => error instanceof ContinuityMemoryError && error.code === 'forbidden');
  assert.throws(() => f.store.record({ pairing: A, operationId: 'bad-inference', layer: 'user_soul', kind: 'inference', text: '用户永远喜欢海边。', origin: 'derived', status: 'candidate' }), (error: unknown) => error instanceof ContinuityMemoryError && error.code === 'invalid_request');
});

test('N07-04 correction keeps an auditable superseded fact and forget leaves a tombstone', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const first = f.store.record({ pairing: A, operationId: 'fact-1', layer: 'user_wiki', kind: 'state', text: '用户在跑步。', origin: 'user', sourceIds: ['conversation:3'], status: 'active' });
  const corrected = f.store.correct({ pairing: A, operationId: 'correct-1', targetId: first.fact.id, expectedVersion: first.fact.version, text: '用户目前暂停跑步。', reason: '用户明确纠正当前状态。' });
  assert.deepEqual(f.store.snapshot(A).wiki.map(item => item.text), ['用户目前暂停跑步。']);
  const raw = f.db.prepare('SELECT status, text, supersedes_id FROM continuity_facts WHERE id=?').get(first.fact.id) as { status: string; text: string; supersedes_id: string };
  assert.deepEqual(raw, { status: 'superseded', text: '用户在跑步。', supersedes_id: null });
  assert.equal(corrected.fact.supersedesId, first.fact.id);
  const forgotten = f.store.forget({ pairing: A, operationId: 'forget-1', targetId: corrected.fact.id, expectedVersion: corrected.fact.version, reason: '用户要求遗忘该状态。' });
  assert.equal(forgotten.fact.status, 'revoked');
  assert.equal(f.store.snapshot(A).wiki.length, 0);
  const tombstone = f.db.prepare('SELECT reason FROM continuity_tombstones WHERE fact_id=?').get(corrected.fact.id) as { reason: string };
  assert.equal(tombstone.reason, '用户要求遗忘该状态。');
});

test('N07-04 state transition preserves history while current snapshot selects only the valid state', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const old = f.store.record({ pairing: A, operationId: 'state-old', layer: 'user_wiki', kind: 'state', text: '用户正在跑步。', origin: 'user', status: 'active', validTo: '2026-09-20T00:00:00.000Z' });
  const current = f.store.record({ pairing: A, operationId: 'state-new', layer: 'user_wiki', kind: 'state', text: '用户暂停跑步。', origin: 'user', status: 'active', validFrom: '2026-09-20T00:00:00.000Z' });
  const snapshot = f.store.snapshot(A, { now: '2026-09-22T00:00:00.000Z' });
  assert.deepEqual(snapshot.wiki.map(item => item.text), ['用户暂停跑步。']);
  assert.equal(old.fact.status, 'active');
  assert.equal(current.fact.status, 'active');
});

test('N07-04 stale derived result cannot write after correction or forget', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const lease = f.store.beginDerived(A);
  const fact = f.store.record({ pairing: A, operationId: 'newer', layer: 'user_soul', kind: 'user_defined', text: '用户喜欢短句。', origin: 'user', status: 'active' });
  assert.ok(fact.revision > lease.revision);
  assert.throws(() => f.store.commitDerived({ lease, operationId: 'late', layer: 'user_soul', kind: 'inference', text: '陈旧推断。', sourceIds: ['conversation:late'] }), (error: unknown) => error instanceof ContinuityMemoryError && error.code === 'version_conflict');
  const lease2 = f.store.beginDerived(A);
  f.store.forget({ pairing: A, operationId: 'forget-newer', targetId: fact.fact.id, expectedVersion: fact.fact.version, reason: 'forget' });
  assert.throws(() => f.store.assertCurrent(lease2), (error: unknown) => error instanceof ContinuityMemoryError && error.code === 'version_conflict');
});

test('N07-04 source revocation excludes a continuity fact without deleting its audit row', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  f.db.exec(`CREATE TABLE character_source_revocations (id TEXT PRIMARY KEY, character_id TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL)`);
  const fact = f.store.record({ pairing: A, operationId: 'source-fact', layer: 'user_wiki', kind: 'fact', text: '来自已导入资料的事实。', origin: 'derived', sourceIds: ['src-1'], status: 'active' });
  assert.equal(f.store.snapshot(A).wiki.length, 1);
  f.db.prepare("INSERT INTO character_source_revocations(id,character_id,target_type,target_id) VALUES('r1','companion','source','src-1')").run();
  assert.equal(f.store.snapshot(A).wiki.length, 0);
  const row = f.db.prepare('SELECT status FROM continuity_facts WHERE id=?').get(fact.fact.id) as { status: string };
  assert.equal(row.status, 'active');
});

test('N07-04 forgetting a fact removes linked companion timeline evidence from reads', async t => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  const packs = await CharacterPackStore.open(db);
  const continuity = await ContinuityMemoryStore.open(db);
  const fact = continuity.record({
    pairing: A,
    operationId: 'timeline-fact',
    layer: 'user_soul',
    kind: 'user_defined',
    text: '用户希望被称为阿航。',
    origin: 'user',
    sourceIds: ['conversation:timeline'],
    status: 'active',
  });
  packs.appendCompanionEvent({
    userId: A.userId,
    characterId: A.characterId,
    characterInstanceId: A.characterInstanceId,
    sessionId: 's-1',
    turnId: 't-1',
    userText: '请记住我的称呼。',
    assistantText: '好的，阿航。',
    sourceIds: [fact.fact.id],
  });
  assert.equal((await packs.getSnapshot(A, { maxCompanionEvents: 10 })).companionTimeline.length, 1);
  continuity.forget({ pairing: A, operationId: 'timeline-forget', targetId: fact.fact.id, expectedVersion: fact.fact.version, reason: '用户要求遗忘称呼。' });
  assert.equal((await packs.getSnapshot(A, { maxCompanionEvents: 10 })).companionTimeline.length, 0);
});
