import test from 'node:test';
import assert from 'node:assert/strict';
import type { CharacterId, ConversationMessage, MemoryChange, MemoryOperation, PerceptionResult, TurnScope } from '../../contracts/index.js';
import { RoleMemoryLedger, type DerivedKind } from '../../memory/ledger.js';

const NOW = '2026-09-06T12:00:00.000Z';
const scope = (characterId: CharacterId = 'companion', turnId = 'turn-1'): TurnScope => ({ characterId, sessionId: 'session-1', turnId, generation: 1 });
const message = (characterId: CharacterId, id: string, text = '我在海风公司工作'): ConversationMessage => ({ characterId, id, role: 'user', text, createdAt: NOW });
const change = (operation: MemoryOperation, operationId: string, owned = scope()): MemoryChange => ({ scope: owned, operationId, operation, reason: 'synthetic test evidence', createdAt: NOW });
function fixture(characterId: CharacterId = 'companion') {
  const ledger = new RoleMemoryLedger(characterId);
  const owned = scope(characterId);
  ledger.append(owned, [message(characterId, 'raw-1')]);
  assert.equal(ledger.apply(change({ type: 'add', id: 'job', text: '在海风公司工作', sourceIds: ['raw-1'] }, 'add-job', owned), NOW).status, 'applied');
  return { ledger, owned };
}
function derivatives(ledger: RoleMemoryLedger, owned: TurnScope) {
  const kinds: DerivedKind[] = ['summary', 'keyword_index', 'vector_index', 'context_cache'];
  for (const [index, kind] of kinds.entries()) ledger.recordDerived(owned, { id: kind, kind, text: '在海风公司工作', sourceIds: [index === 0 ? 'job' : kinds[index - 1]!], createdAt: NOW });
  return kinds;
}

test('A09: only companion is admitted; legacy identities cannot read or mutate matching IDs', () => {
  const a = fixture('companion');
  const b = {owned: scope('sweetheart')};
  assert.throws(() => fixture('sweetheart'), /unknown_character/);
  const update = change({ type: 'update', id: 'job', expectedVersion: 1, text: '朋友自己的新公司', sourceIds: ['raw-1'] }, 'u1', a.owned);
  a.ledger.apply(update, NOW);
  assert.equal(a.ledger.contextRecords(a.owned).memories[0]!.text, '朋友自己的新公司');
  assert.throws(() => a.ledger.contextRecords(b.owned), /character_mismatch/);
  assert.throws(() => a.ledger.inspect(b.owned, 'job'), /character_mismatch/);
  assert.equal(a.ledger.apply(change({ type: 'soft_delete', id: 'job', expectedVersion: 2 }, 'foreign', b.owned), NOW).status, 'rejected');
});

test('A09: malformed role and cross-role append reject the whole batch', () => {
  assert.throws(() => new RoleMemoryLedger('third' as CharacterId), /unknown_character/);
  const ledger = new RoleMemoryLedger('companion');
  assert.throws(() => ledger.append(scope(), [message('companion', 'a'), message('sweetheart', 'b')]), /character_mismatch/);
  assert.equal(ledger.contextRecords(scope()).recent.length, 0);
  assert.throws(() => ledger.append(scope(), [message('companion', 'a'), message('companion', 'a')]), /duplicate_id/);
  assert.equal(ledger.contextRecords(scope()).recent.length, 0);
});

test('A09: unknown and other-role source IDs cannot be used in summaries or memories', () => {
  const { ledger, owned } = fixture();
  assert.throws(() => ledger.recordDerived(owned, { id: 'bad', kind: 'summary', text: 'wrong', sourceIds: ['sweetheart-only'], createdAt: NOW }), /source_not_retrievable/);
  assert.equal(ledger.apply(change({ type: 'add', id: 'bad', text: 'wrong', sourceIds: ['sweetheart-only'] }, 'bad'), NOW).status, 'rejected');
});

test('A09: emotion history remains scoped and a mismatched turn is rejected', () => {
  const { ledger, owned } = fixture();
  const result: PerceptionResult = { scope: owned, transcript: '没事', modalities: [], cues: [], status: 'partial' };
  ledger.recordPerception(owned, 'emotion-1', result, NOW, ['raw-1']);
  assert.equal(ledger.visible(owned, 'emotion').length, 1);
  assert.throws(() => ledger.visible(scope('sweetheart'), 'emotion'), /character_mismatch/);
  assert.throws(() => ledger.recordPerception(owned, 'emotion-2', { ...result, scope: scope('companion', 'old-turn') }, NOW, ['raw-1']), /perception_scope_mismatch/);
});

test('A10: delayed work uses its captured role after session change; unsupported identities remain refused', async () => {
  const friend = fixture('companion');
  const next = {...friend.owned, sessionId: 'new-session', generation: 2};
  let current = friend.owned;
  const task = friend.ledger.captureMaintenance(current);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const pending = (async () => {
    await gate;
    return friend.ledger.completeMaintenance(task, [change({ type: 'add', id: 'late', text: '原角色自己的待跟进事项', sourceIds: ['raw-1'] }, 'late', task.scope)], NOW);
  })();
  current = next;
  release();
  assert.equal((await pending)[0]!.status, 'applied');
  assert.equal(current.sessionId, 'new-session');
  assert.equal(task.scope.sessionId, 'session-1');
  assert.equal(friend.ledger.visible(friend.owned, 'memory').length, 2);
  assert.throws(() => fixture('sweetheart'), /unknown_character/);
});

test('A10: a provider cannot redirect the result to the current role or another turn', () => {
  const { ledger, owned } = fixture();
  for (const foreign of [scope('sweetheart'), scope('companion', 'other')]) {
    const task = ledger.captureMaintenance(owned);
    const results = ledger.completeMaintenance(task, [change({ type: 'add', id: 'bad', text: 'bad', sourceIds: ['raw-1'] }, 'redirect', foreign)], NOW);
    assert.equal(results[0]!.reason, 'task_scope_mismatch');
    assert.equal(ledger.inspect(owned, 'bad'), null);
  }
});

test('A10: late old extraction cannot recreate a forgotten fact under a new ID', () => {
  const { ledger, owned } = fixture();
  const task = ledger.captureMaintenance(owned);
  ledger.applyResolvedChange(change({ type: 'soft_delete', id: 'job', expectedVersion: 1 }, 'forget'), ['raw-1'], NOW);
  const result = ledger.completeMaintenance(task, [change({ type: 'add', id: 'resurrected', text: '在海风公司工作', sourceIds: ['raw-1'] }, 'late-add')], NOW);
  assert.equal(result[0]!.reason, 'stale_maintenance_epoch');
  assert.equal(ledger.inspect(owned, 'resurrected'), null);
  assert.deepEqual(ledger.captureMaintenance(owned).input.messages, []);
});

test('A10: sources added after capture and consumed/forged tickets cannot authorize changes', () => {
  const { ledger, owned } = fixture();
  const task = ledger.captureMaintenance(owned);
  ledger.append(owned, [message('companion', 'future')]);
  const op = change({ type: 'add', id: 'future-memory', text: 'future', sourceIds: ['future'] }, 'future');
  assert.equal(ledger.completeMaintenance(task, [op], NOW)[0]!.reason, 'source_not_in_task_input');
  assert.equal(ledger.completeMaintenance(task, [op], NOW)[0]!.reason, 'unknown_or_consumed_task');
  assert.equal(ledger.completeMaintenance(structuredClone(task), [op], NOW)[0]!.reason, 'unknown_or_consumed_task');
});

test('A12: correction removes the old source and transitive summary/index/cache before returning', () => {
  const { ledger, owned } = fixture();
  const kinds = derivatives(ledger, owned);
  const oldContext = ledger.contextRecords(owned);
  ledger.append(owned, [message('companion', 'new-job', '我换工作了，现在在山川公司')]);
  const result = ledger.applyResolvedChange(change({ type: 'update', id: 'job', expectedVersion: 1, text: '在山川公司工作', sourceIds: ['new-job'] }, 'correct'), ['raw-1'], NOW);
  assert.equal(result.status, 'applied');
  assert.equal(result.retrievalInvalidated, true);
  assert.equal(ledger.contextRecords(owned).memories[0]!.text, '在山川公司工作');
  assert.deepEqual(ledger.contextRecords(owned).recent.map(item => item.id), ['new-job']);
  for (const kind of kinds) assert.deepEqual(ledger.visible(owned, kind), []);
  assert.throws(() => ledger.assertContextCurrent(owned, oldContext.revision), /stale_context/);
});

test('A12: forgetting exits every declared path synchronously, without deleting an independent product store', () => {
  const { ledger, owned } = fixture();
  const other = fixture('companion');
  const kinds = derivatives(ledger, owned);
  const result = ledger.applyResolvedChange(change({ type: 'soft_delete', id: 'job', expectedVersion: 1 }, 'forget'), ['raw-1'], NOW);
  assert.equal(result.status, 'applied');
  for (const kind of ['memory', 'transcript', ...kinds] as const) assert.deepEqual(ledger.visible(owned, kind), []);
  assert.equal(ledger.inspect(owned, 'job')!.state, 'deleted');
  assert.equal(other.ledger.visible(other.owned, 'memory').length, 1);
});

test('A12: failed resolution or version conflict cannot partially delete sources', () => {
  const { ledger, owned } = fixture();
  const before = ledger.contextRecords(owned);
  assert.equal(ledger.applyResolvedChange(change({ type: 'soft_delete', id: 'job', expectedVersion: 99 }, 'wrong-v'), ['raw-1'], NOW).status, 'conflict');
  assert.equal(ledger.applyResolvedChange(change({ type: 'soft_delete', id: 'job', expectedVersion: 1 }, 'bad-source'), ['unknown'], NOW).status, 'rejected');
  assert.deepEqual(ledger.contextRecords(owned), before);
});

test('A12: direct source suppression traverses multi-level copies and blocks new derived records', () => {
  const { ledger, owned } = fixture();
  derivatives(ledger, owned);
  const affected = ledger.suppressSources(owned, ['raw-1'], 'resolved forgotten topic', NOW);
  assert.ok(affected.includes('context_cache'));
  assert.equal(ledger.visible(owned, 'memory').length, 0);
  assert.throws(() => ledger.recordDerived(owned, { id: 'retry-summary', kind: 'summary', text: 'old', sourceIds: ['raw-1'], createdAt: NOW }), /source_not_retrievable/);
});

test('update uses expectedVersion, rejects cycles, and leaves failed changes untouched', () => {
  const { ledger, owned } = fixture();
  derivatives(ledger, owned);
  const before = ledger.contextRecords(owned);
  assert.equal(ledger.apply(change({ type: 'update', id: 'job', expectedVersion: 10, text: 'wrong', sourceIds: ['raw-1'] }, 'stale'), NOW).status, 'conflict');
  assert.equal(ledger.apply(change({ type: 'update', id: 'job', expectedVersion: 1, text: 'loop', sourceIds: ['summary'] }, 'loop'), NOW).reason, 'cyclic_source');
  assert.deepEqual(ledger.contextRecords(owned), before);
});

test('merge verifies all versions before mutation and retires both old records', () => {
  const { ledger, owned } = fixture();
  ledger.apply(change({ type: 'add', id: 'duplicate', text: '海风公司工作', sourceIds: ['raw-1'] }, 'duplicate'), NOW);
  const makeMerge = (v: number): MemoryOperation => ({ type: 'merge', targets: [{ id: 'job', expectedVersion: 1 }, { id: 'duplicate', expectedVersion: v }], replacement: { id: 'merged', text: '在海风公司工作', sourceIds: ['raw-1'] } });
  const before = ledger.contextRecords(owned);
  assert.equal(ledger.apply(change(makeMerge(3), 'bad-merge'), NOW).status, 'conflict');
  assert.deepEqual(ledger.contextRecords(owned), before);
  assert.equal(ledger.apply(change(makeMerge(1), 'merge'), NOW).status, 'applied');
  assert.deepEqual(ledger.contextRecords(owned).memories.map(item => item.id), ['merged']);
});

test('A14: restore is allowed within 30 days and never revives stale summaries/caches', () => {
  const { ledger, owned } = fixture();
  derivatives(ledger, owned);
  ledger.applyResolvedChange(change({ type: 'soft_delete', id: 'job', expectedVersion: 1 }, 'forget'), ['raw-1'], NOW);
  const result = ledger.apply(change({ type: 'restore', id: 'job', expectedVersion: 2 }, 'restore'), '2026-10-06T11:59:59.999Z');
  assert.equal(result.status, 'applied');
  assert.equal(ledger.contextRecords(owned).memories.length, 1);
  assert.deepEqual(ledger.visible(owned, 'summary'), []);
  assert.deepEqual(ledger.visible(owned, 'context_cache'), []);
});

test('A14: retention boundary purges payload, rejects restore and prevents reused IDs/operation IDs', () => {
  const { ledger, owned } = fixture();
  ledger.apply(change({ type: 'soft_delete', id: 'job', expectedVersion: 1 }, 'forget'), NOW);
  assert.deepEqual(ledger.purgeDeleted(owned, '2026-10-06T11:59:59.999Z'), []);
  assert.equal(ledger.apply(change({ type: 'restore', id: 'job', expectedVersion: 2 }, 'late-restore'), '2026-10-06T12:00:00.000Z').reason, 'restore_window_closed');
  assert.deepEqual(ledger.purgeDeleted(owned, '2026-10-06T12:00:00.000Z'), ['job']);
  const tombstone = ledger.inspect(owned, 'job')!;
  assert.equal(tombstone.text, ''); assert.deepEqual(tombstone.sources, []); assert.equal(tombstone.state, 'purged');
  assert.equal(ledger.apply(change({ type: 'add', id: 'job', text: 'old', sourceIds: ['raw-1'] }, 'reuse-id'), NOW).status, 'rejected');
  assert.equal(ledger.apply(change({ type: 'add', id: 'different', text: 'old', sourceIds: ['raw-1'] }, 'add-job'), NOW).reason, 'operation_id_already_used');
});

test('expiry primitive removes selected raw payload without cascading to long memory or summary', () => {
  const { ledger, owned } = fixture();
  derivatives(ledger, owned);
  const task = ledger.captureMaintenance(owned);
  ledger.expireTranscripts(owned, ['raw-1']);
  assert.deepEqual(ledger.contextRecords(owned).recent, []);
  assert.equal(ledger.contextRecords(owned).memories[0]!.text, '在海风公司工作');
  assert.equal(ledger.visible(owned, 'summary').length, 1);
  assert.equal(ledger.inspect(owned, 'raw-1')!.text, '');
  assert.equal(ledger.inspect(owned, 'raw-1')!.message, null);
  assert.equal(ledger.completeMaintenance(task, [change({ type: 'add', id: 'late', text: 'old', sourceIds: ['raw-1'] }, 'late')], NOW)[0]!.reason, 'stale_maintenance_epoch');
});

test('returned objects and caller mutations cannot alter ledger content or task scope', () => {
  const ledger = new RoleMemoryLedger('companion');
  const input = message('companion', 'raw-1');
  ledger.append(scope(), [input]);
  (input as { text: string }).text = 'changed outside';
  const read = ledger.contextRecords(scope());
  (read.recent[0] as { text: string }).text = 'changed read';
  assert.equal(ledger.contextRecords(scope()).recent[0]!.text, '我在海风公司工作');
  const owned = scope();
  const task = ledger.captureMaintenance(owned);
  (owned as { characterId: CharacterId }).characterId = 'sweetheart';
  assert.equal(task.scope.characterId, 'companion');
});

test('R16: after raw expiry, maintenance can update a living memory using its previous version as evidence', () => {
  const { ledger, owned } = fixture();
  ledger.expireTranscripts(owned, ['raw-1']);
  const task = ledger.captureMaintenance(owned);
  const result = ledger.completeMaintenance(task, [change({ type: 'update', id: 'job', expectedVersion: 1, text: '仍有效的海风公司任职事实', sourceIds: ['job'] }, 'update-after-expiry')], NOW);
  assert.equal(result[0]!.status, 'applied');
  assert.deepEqual(ledger.inspect(owned, 'job')!.sources, [{ id: 'raw-1', version: 1 }, { id: 'job', version: 1 }]);
  assert.equal(ledger.inspect(owned, 'raw-1')!.message, null);
  assert.equal(ledger.contextRecords(owned).memories[0]!.text, '仍有效的海风公司任职事实');
});

test('R16: expired raw sources are not readable evidence, but living memory IDs support merge and payload purge', () => {
  const { ledger, owned } = fixture();
  ledger.apply(change({ type: 'add', id: 'duplicate', text: '海风公司任职', sourceIds: ['raw-1'] }, 'add-duplicate'), NOW);
  ledger.expireTranscripts(owned, ['raw-1']);
  const bad = ledger.captureMaintenance(owned);
  assert.equal(ledger.completeMaintenance(bad, [change({ type: 'add', id: 'bad', text: '旧原文', sourceIds: ['raw-1'] }, 'bad-raw')], NOW)[0]!.reason, 'source_not_in_task_input');
  const task = ledger.captureMaintenance(owned);
  const result = ledger.completeMaintenance(task, [change({ type: 'merge', targets: [{ id: 'job', expectedVersion: 1 }, { id: 'duplicate', expectedVersion: 1 }], replacement: { id: 'merged', text: '在海风公司工作', sourceIds: ['job', 'duplicate'] } }, 'merge-from-living')], NOW);
  assert.equal(result[0]!.status, 'applied');
  assert.deepEqual(ledger.inspect(owned, 'merged')!.sources, [{ id: 'raw-1', version: 1 }, { id: 'job', version: 1 }, { id: 'duplicate', version: 1 }]);
  ledger.purgeDeleted(owned, '2026-10-07T12:00:00Z');
  assert.equal(ledger.visible(owned, 'memory')[0]!.text, '在海风公司工作');
  const late = ledger.captureMaintenance(owned);
  assert.equal(ledger.completeMaintenance(late, [change({ type: 'add', id: 'bad-deleted', text: '旧记忆', sourceIds: ['job'] }, 'bad-deleted')], NOW)[0]!.reason, 'source_not_in_task_input');
});

test('A12/A14: derived payload disappears immediately, dependent memories use their own soft-delete window', () => {
  const { ledger, owned } = fixture();
  const kinds = derivatives(ledger, owned);
  ledger.apply(change({ type: 'add', id: 'copy', text: '在海风公司工作', sourceIds: ['job'] }, 'copy'), NOW);
  ledger.recordPerception(owned, 'emotion', { scope: owned, transcript: '我在海风公司工作', cues: [], modalities: [], status: 'partial' }, NOW, ['raw-1']);
  assert.equal(ledger.inspect(owned, 'emotion')!.perception!.transcript, '');
  ledger.applyResolvedChange(change({ type: 'soft_delete', id: 'job', expectedVersion: 1 }, 'forget-all'), ['raw-1'], NOW);
  for (const id of kinds) {
    assert.equal(ledger.inspect(owned, id)!.text, '');
    assert.ok(['source_invalidated', 'context_revision_changed'].includes(ledger.inspect(owned, id)!.reason!));
  }
  assert.equal(ledger.inspect(owned, 'emotion')!.perception, null);
  assert.equal(ledger.inspect(owned, 'copy')!.state, 'deleted');
  assert.deepEqual([...ledger.purgeDeleted(owned, '2026-10-07T12:00:00Z')].sort(), ['copy', 'job']);
  assert.equal(ledger.inspect(owned, 'copy')!.text, '');
  // Source transcript is hidden, but its raw retention is a separate adapter's responsibility.
  assert.equal(ledger.visible(owned, 'transcript').length, 0);
  ledger.expireTranscripts(owned, ['raw-1']);
  assert.equal(ledger.inspect(owned, 'raw-1')!.text, '');
});

test('source lineage survives a self-update and merge so later source suppression still reaches replacements', () => {
  const { ledger, owned } = fixture();
  ledger.apply(change({ type: 'update', id: 'job', expectedVersion: 1, text: '海风公司任职', sourceIds: ['job'] }, 'self-update'), NOW);
  ledger.apply(change({ type: 'add', id: 'copy', text: '海风公司任职', sourceIds: ['job'] }, 'copy'), NOW);
  ledger.apply(change({ type: 'merge', targets: [{ id: 'job', expectedVersion: 2 }, { id: 'copy', expectedVersion: 1 }], replacement: { id: 'merged', text: '海风公司任职', sourceIds: ['job', 'copy'] } }, 'merge'), NOW);
  ledger.purgeDeleted(owned, '2026-10-07T12:00:00Z');
  assert.equal(ledger.visible(owned, 'memory').length, 1);
  ledger.suppressSources(owned, ['raw-1'], 'resolved forget', '2026-10-07T12:00:00Z');
  assert.equal(ledger.visible(owned, 'memory').length, 0);
});

test('equal-time transcript messages preserve append order instead of sorting assistant before user', () => {
  const ledger = new RoleMemoryLedger('companion');
  ledger.append(scope(), [message('companion', 'z-user', '你好'), { ...message('companion', 'a-assistant', '你好呀'), role: 'assistant' }]);
  assert.deepEqual(ledger.contextRecords(scope()).recent.map(item => item.role), ['user', 'assistant']);
});

test('new facts invalidate negative context-cache results even without a dependency on the new ID', () => {
  const { ledger, owned } = fixture();
  ledger.recordDerived(owned, { id: 'empty-result', kind: 'context_cache', text: '尚无旅行计划', sourceIds: ['raw-1'], createdAt: NOW });
  ledger.append(owned, [message('companion', 'travel', '计划下周去苏州')]);
  assert.deepEqual(ledger.visible(owned, 'context_cache'), []);
  assert.equal(ledger.inspect(owned, 'empty-result')!.text, '');
  ledger.recordDerived(owned, { id: 'cached-old-memory', kind: 'context_cache', text: '记忆中无旅行计划', sourceIds: ['job'], createdAt: NOW });
  const result = ledger.apply(change({ type: 'add', id: 'trip', text: '下周去苏州', sourceIds: ['travel'] }, 'trip'), NOW);
  assert.ok(result.affectedIds.includes('cached-old-memory'));
  assert.deepEqual(ledger.visible(owned, 'context_cache'), []);
});
