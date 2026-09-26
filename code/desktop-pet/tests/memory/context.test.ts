import test from 'node:test';
import assert from 'node:assert/strict';
import type { CharacterId, PerceptionResult, TurnScope } from '../../contracts/index.js';
import { RoleMemoryLedger } from '../../memory/ledger.js';
import { assembleContext, type ContextOptions } from '../../memory/context.js';

const NOW = '2026-09-06T12:00:00Z';
const scope = (characterId: CharacterId = 'companion'): TurnScope => ({ characterId, sessionId: 'session', turnId: 'turn', generation: 1 });
const options = (overrides: Partial<ContextOptions> = {}): ContextOptions => ({
  prompts: { companion: 'COMPANION' }, inputTokenBudget: 10000, maxRecentMessages: 4, maxMemories: 2,
  // Deliberately synthetic deterministic counter. This is not a real model tokenizer.
  countTokens: (context, text) => JSON.stringify(context).length + text.length,
  relevance: (memory, query) => memory.text.includes(query) ? 1 : 0, ...overrides,
});
function fixture(characterId: CharacterId = 'companion') {
  const owned = scope(characterId);
  const ledger = new RoleMemoryLedger(characterId);
  ledger.append(owned, [{ characterId, id: 'raw', role: 'user', text: `${characterId} 我喜欢茶`, createdAt: NOW }]);
  for (const [id, text] of [['tea', `${characterId} 喜欢茶`], ['coffee', `${characterId} 咖啡记录`]]) {
    ledger.apply({ scope: owned, operationId: id!, reason: 'test', createdAt: NOW, operation: { type: 'add', id: id!, text: text!, sourceIds: ['raw'] } }, NOW);
  }
  return { owned, ledger };
}

test('A09: assembly and relevance scorer only see the selected character', () => {
  const friend = fixture();
  const sweetheart = {owned: scope('sweetheart')};
  const seen: CharacterId[] = [];
  const result = assembleContext(friend.ledger, friend.owned, '茶', null, NOW, options({ relevance: memory => { seen.push(memory.characterId); return 1; } }));
  assert.equal(result.context.characterPrompt, 'COMPANION');
  assert.ok(seen.every(role => role === 'companion'));
  assert.ok(result.context.recent.every(item => item.characterId === 'companion'));
  assert.ok(result.context.memories.every(item => item.characterId === 'companion'));
  assert.throws(() => assembleContext(friend.ledger, sweetheart.owned, '茶', null, NOW, options()), /character_mismatch/);
});

test('context excludes irrelevant memories and includes newly appended facts before extraction', () => {
  const { ledger, owned } = fixture();
  ledger.append(owned, [{ characterId: 'companion', id: 'pending', role: 'user', text: '刚换到山川公司，还没提取记忆', createdAt: '2026-09-06T12:01:00Z' }]);
  const result = assembleContext(ledger, owned, '茶', null, NOW, options());
  assert.deepEqual(result.context.memories.map(item => item.id), ['tea']);
  assert.ok(result.context.recent.some(item => item.id === 'pending'));
  assert.ok(result.omittedIds.includes('coffee'));
});

test('input budget is explicit, counts current text, and excludes whole items without output truncation', () => {
  const { ledger, owned } = fixture();
  const config = options({ inputTokenBudget: 20, countTokens: (context, text) => text.length + context.characterPrompt.length + context.recent.length * 20 + context.memories.length * 3 });
  const result = assembleContext(ledger, owned, '茶', null, NOW, config);
  assert.equal(result.context.recent.length, 0);
  assert.equal(result.context.memories.length, 1);
  assert.ok(result.countedInputTokens <= 20);
  assert.ok(result.omittedIds.includes('raw'));
  assert.throws(() => assembleContext(ledger, owned, 'x'.repeat(30), null, NOW, config), /required_context_exceeds_budget/);
});

test('expired emotion cues are excluded and other-role/other-turn perception is rejected', () => {
  const { ledger, owned } = fixture();
  const perception: PerceptionResult = { scope: owned, transcript: '没事', status: 'partial', modalities: [], cues: [
    { label: '低落', confidence: null, uncertainty: '可能', evidence: ['audio'], expiresAt: NOW },
    { label: '紧张', confidence: 0.6, uncertainty: '线索模糊', evidence: ['image'], expiresAt: '2026-09-06T12:01:00Z' },
  ] };
  const context = assembleContext(ledger, owned, '茶', perception, NOW, options()).context;
  assert.deepEqual(context.perception!.cues.map(cue => cue.label), ['紧张']);
  assert.equal(context.perception!.cues[0]!.uncertainty, '线索模糊');
  assert.equal(perception.cues.length, 2);
  for (const badScope of [scope('sweetheart'), { ...owned, turnId: 'different' }]) {
    assert.throws(() => assembleContext(ledger, owned, '茶', { ...perception, scope: badScope }, NOW, options()), /perception_scope_mismatch/);
  }
});

test('retained snapshots become stale after deletion; callbacks cannot silently race assembly', () => {
  const { ledger, owned } = fixture();
  const result = assembleContext(ledger, owned, '茶', null, NOW, options());
  ledger.suppressSources(owned, ['raw'], 'forget', NOW);
  assert.throws(() => ledger.assertContextCurrent(owned, result.revision), /stale_context/);
  const next = assembleContext(ledger, owned, '茶', null, NOW, options());
  assert.deepEqual(next.context.memories, []); assert.deepEqual(next.context.recent, []);
  const other = fixture();
  assert.throws(() => assembleContext(other.ledger, other.owned, '茶', null, NOW, options({ relevance: () => { other.ledger.suppressSources(other.owned, ['raw'], 'callback mutation', NOW); return 1; } })), /stale_context/);
});

test('invalid budgets, counters, scores and missing prompt reject instead of choosing hidden defaults', () => {
  const { ledger, owned } = fixture();
  for (const config of [options({ inputTokenBudget: 0 }), options({ maxMemories: -1 }), options({ countTokens: () => NaN }), options({ relevance: () => Infinity }), options({ prompts: { companion: '' } })]) {
    assert.throws(() => assembleContext(ledger, owned, '茶', null, NOW, config));
  }
});
