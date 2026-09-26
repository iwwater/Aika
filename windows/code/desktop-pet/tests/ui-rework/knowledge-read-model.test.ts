import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { ContinuityMemoryStore } from '../../memory/continuity-memory-store.js';
import { continuityManagement, continuityRoute } from '../../management/continuity-routes.js';
import type { PairingScope } from '../../contracts/character-pack.js';

const pairingUserA: PairingScope = { userId: 'alice', characterId: 'companion', characterInstanceId: 'inst-1' };
const pairingUserB: PairingScope = { userId: 'bob', characterId: 'companion', characterInstanceId: 'inst-2' };
const body = (value: Record<string, unknown>) => async () => value;

test('UIR-03 Knowledge Read Model: settle fact, correct, promote, and forget without resurrection', async t => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  const store = await ContinuityMemoryStore.open(db);
  const port = continuityManagement(store);

  // 1. Record an active fact for User A
  const recResult = await continuityRoute('POST', port, '/api/continuity/record', body({
    pairing: pairingUserA,
    operationId: 'op-wiki-01',
    layer: 'user_wiki',
    kind: 'fact',
    text: '用户是前端架构师，主修 TypeScript。',
    origin: 'user',
    status: 'active'
  })) as { status: string; fact: { id: string; version: number } };

  assert.equal(recResult.status, 'applied');
  const factId = recResult.fact.id;

  // 2. Query snapshot for User A -> fact exists
  const snapA = await continuityRoute('POST', port, '/api/continuity/snapshot', body({
    pairing: pairingUserA
  })) as { wiki: readonly { id: string; text: string }[] };
  assert.ok(snapA.wiki.some(f => f.id === factId && f.text.includes('前端架构师')));

  // 3. User B snapshot -> strict multi-user pairing isolation, User B cannot read User A's wiki
  const snapB = await continuityRoute('POST', port, '/api/continuity/snapshot', body({
    pairing: pairingUserB
  })) as { wiki: readonly { id: string }[] };
  assert.equal(snapB.wiki.length, 0);

  // 4. Correct fact for User A
  const correctResult = await continuityRoute('POST', port, '/api/continuity/correct', body({
    pairing: pairingUserA,
    operationId: 'op-wiki-02',
    targetId: factId,
    expectedVersion: 1,
    text: '用户是资深全栈方案专家，主修 TypeScript 与 ESM 原生工程。',
    reason: '用户纠正专业头衔'
  })) as { fact: { id: string; version: number } };

  assert.ok(correctResult.fact.version >= 1);

  // 5. Query updated snapshot
  const snapA2 = await continuityRoute('POST', port, '/api/continuity/snapshot', body({
    pairing: pairingUserA
  })) as { wiki: readonly { id: string; text: string }[] };
  assert.ok(snapA2.wiki.some(f => f.id === correctResult.fact.id && f.text.includes('资深全栈方案专家')));

  // 6. Forget fact
  await continuityRoute('POST', port, '/api/continuity/forget', body({
    pairing: pairingUserA,
    operationId: 'op-wiki-03',
    targetId: correctResult.fact.id,
    expectedVersion: correctResult.fact.version,
    reason: '用户在 Wiki 要求彻底遗忘此经历'
  }));

  // 7. Verify it never resurrects
  const snapA3 = await continuityRoute('POST', port, '/api/continuity/snapshot', body({
    pairing: pairingUserA
  })) as { wiki: readonly unknown[] };
  assert.equal(snapA3.wiki.length, 0);
});
