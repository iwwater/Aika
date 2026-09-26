import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { ContinuityMemoryStore } from '../../memory/continuity-memory-store.js';
import { continuityManagement, continuityRoute } from '../../management/continuity-routes.js';
import type { PairingScope } from '../../contracts/character-pack.js';

const pairing: PairingScope = { userId: 'route-user', characterId: 'companion', characterInstanceId: 'route-instance' };
const body = (value: Record<string, unknown>) => async () => value;

test('N07-05 continuity management route exposes snapshot, correction and forget with revision checks', async t => {
  const db = new Database(':memory:'); t.after(() => db.close());
  const port = continuityManagement(await ContinuityMemoryStore.open(db));
  const created = await continuityRoute('POST', port, '/api/continuity/record', body({ pairing, operationId: 'route-record', layer: 'user_soul', kind: 'user_defined', text: '称呼是阿航。', origin: 'user', status: 'active' }));
  assert.equal((created as { status: string }).status, 'applied');
  const factId = (created as { fact: { id: string; version: number } }).fact.id;
  const corrected = await continuityRoute('POST', port, '/api/continuity/correct', body({ pairing, operationId: 'route-correct', targetId: factId, expectedVersion: 1, text: '称呼是阿航同学。', reason: '用户修正称呼。' }));
  const correctedId = (corrected as { fact: { id: string; version: number } }).fact.id;
  const snapshot = await continuityRoute('POST', port, '/api/continuity/snapshot', body({ pairing }));
  assert.deepEqual((snapshot as { soul: readonly { text: string }[] }).soul.map(item => item.text), ['称呼是阿航同学。']);
  await continuityRoute('POST', port, '/api/continuity/forget', body({ pairing, operationId: 'route-forget', targetId: correctedId, expectedVersion: 1, reason: '用户要求遗忘。' }));
  const final = await continuityRoute('POST', port, '/api/continuity/snapshot', body({ pairing }));
  assert.equal((final as { soul: readonly unknown[] }).soul.length, 0);
});

test('N07-05 continuity management route requires POST and refuses assistant facts', async t => {
  const db = new Database(':memory:'); t.after(() => db.close());
  const port = continuityManagement(await ContinuityMemoryStore.open(db));
  assert.throws(() => continuityRoute('GET', port, '/api/continuity/record', body({})), /没有这个连续性操作/);
  await assert.rejects(async () => { await continuityRoute('POST', port, '/api/continuity/record', body({ pairing, operationId: 'assistant', layer: 'user_wiki', kind: 'fact', text: '我们昨天一起旅行。', origin: 'assistant', status: 'active' })); }, /该内容不能作为用户事实保存/);
});
