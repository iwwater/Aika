import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { ContinuityMemoryStore } from '../../memory/continuity-memory-store.js';
import { ContinuityContextComposer } from '../../memory/continuity-context.js';
import type { PairingScope, ContinuitySnapshot } from '../../contracts/character-pack.js';

const pairing: PairingScope = { userId: 'context-user', characterId: 'companion', characterInstanceId: 'context-instance' };
const pack = {
  id: 'pack-1', characterId: 'companion', packVersion: 'v1.0', schemaVersion: '0.7', name: '沈砚', soul: '沉稳、克制，重视承诺。', styleHints: ['短句', '先观察再回答'],
  canonFacts: [], canonTimeline: [{ eventId: 'canon-1', ordinal: 0, summary: '暴雨夜把斗篷留给受困旅人。', charactersInvolved: ['沈砚'], awareness: 'experienced' as const, evidenceIds: ['src-1:b0'], status: 'explicit' as const }], gaps: [], sourceIds: ['src-1'], sourceHashes: ['hash'], cutoffPoint: undefined, workTitle: '临海城', draftId: undefined, activatedAt: '2026-09-22T00:00:00.000Z', createdAt: '2026-09-22T00:00:00.000Z',
} as const;
function readPort(revision = 1): { port: { getSnapshot(): Promise<ContinuitySnapshot> }; current: () => number } {
  let current = revision;
  const snapshot = (): ContinuitySnapshot => ({ pairing, activePack: pack, canonTimeline: pack.canonTimeline, companionTimeline: [{ eventId: 'comp-1', userId: pairing.userId, characterId: pairing.characterId, characterInstanceId: pairing.characterInstanceId, sessionId: 's', turnId: 't', userText: '我叫阿航。', assistantText: '记住了。', createdAt: '2026-09-22T00:00:00.000Z' }], packRevision: current });
  return { port: { getSnapshot: async () => snapshot() }, current: () => current };
}

test('N07-05 composes bounded, deduplicated and explainable continuity context', async t => {
  const db = new Database(':memory:'); t.after(() => db.close());
  const memory = await ContinuityMemoryStore.open(db);
  memory.record({ pairing, operationId: 'soul', layer: 'user_soul', kind: 'user_defined', text: '用户希望被称为阿航。', origin: 'user', status: 'active' });
  memory.record({ pairing, operationId: 'rel', layer: 'relationship', kind: 'milestone', text: '双方约定区分原作与共同经历。', origin: 'manual', status: 'active' });
  memory.record({ pairing, operationId: 'wiki', layer: 'user_wiki', kind: 'fact', text: '用户希望被称为阿航。', origin: 'conversation', sourceIds: ['u:1'], status: 'active' });
  const fake = readPort();
  const result = await new ContinuityContextComposer(fake.port, memory).compose({ pairing, query: '阿航 暴雨', tokenBudget: 100 });
  assert.ok(result.text.includes('角色底色'));
  assert.ok(result.text.includes('阿航'));
  assert.ok(result.text.includes('暴雨夜'));
  assert.ok(result.selected.length < result.segments.length || result.omitted.length > 0);
  assert.ok(result.omitted.some(segment => segment.reason.includes('重复')));
  assert.ok(result.selected.every(segment => segment.tokens > 0));
});

test('N07-05 composer rejects a stale User Soul context before delivery', async t => {
  const db = new Database(':memory:'); t.after(() => db.close());
  const memory = await ContinuityMemoryStore.open(db);
  const fake = readPort();
  const composer = new ContinuityContextComposer(fake.port, memory);
  const result = await composer.compose({ pairing, query: 'hello', tokenBudget: 100 });
  memory.record({ pairing, operationId: 'late-fact', layer: 'user_soul', kind: 'user_defined', text: '用户喜欢短句。', origin: 'user', status: 'active' });
  await assert.rejects(() => composer.assertCurrent(result), /Context 已失效/);
});

test('N07-05 composer keeps unrelated pair content out of the prompt', async t => {
  const db = new Database(':memory:'); t.after(() => db.close());
  const memory = await ContinuityMemoryStore.open(db);
  const other: PairingScope = { ...pairing, characterInstanceId: 'other' };
  memory.record({ pairing: other, operationId: 'other-fact', layer: 'user_soul', kind: 'user_defined', text: '另一实例的私密项目。', origin: 'user', status: 'active' });
  const fake = readPort();
  const result = await new ContinuityContextComposer(fake.port, memory).compose({ pairing, query: '项目', tokenBudget: 100 });
  assert.ok(!result.text.includes('私密项目'));
});
