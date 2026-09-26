import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, scope, message, change } from '../memory/sqlite-fixture.js';
import { lifecycle, signal, replyMessage } from '../memory/lifecycle-fixture.js';
import { SqliteManagementMemoryPort } from '../../memory/management-port.js';

test('N075-01 R6: Context Inspector exposes actual consumed snapshot, candidates, and stale safety', async t => {
  const f = fixture();
  t.after(f.cleanup);
  const store = f.open();
  const port = lifecycle(store);

  const mgmtPort = new SqliteManagementMemoryPort(store, port);

  // 1. Before any turn: inspection indicates preview mode
  const initial = await mgmtPort.context('companion', 'test query');
  assert.equal(initial.inspection?.isIssuedSnapshot, false);
  assert.ok(initial.note.includes('试算'));

  // 2. Add an active memory record to store
  const userScope = scope('companion', 'turn-insp-1');
  const userMsg = message('turn-insp-1:user', '我喜欢喝红茶。');
  await port.append(userScope, [userMsg]);
  store.apply(change({
    type: 'add',
    id: 'mem-tea-1',
    text: '用户喜欢喝红茶',
    sourceIds: ['turn-insp-1:user'],
  }, 'op-seed-tea', userScope));

  // Execute a turn that recalls this memory and consumes context
  const turn2Scope = scope('companion', 'turn-insp-2');
  const userMsg2 = message('turn-insp-2:user', '红茶');
  await port.append(turn2Scope, [userMsg2]);

  const context2 = await port.foregroundContext(turn2Scope, 'turn-insp-2:user', '红茶', null, signal());
  assert.ok(context2.memories.length > 0, 'Turn 2 recalls active memory');
  const recalledId = context2.memories[0]!.id;

  // Complete assistant reply to mark context as consumed in sqlite-recall
  await port.appendAssistant(turn2Scope, replyMessage(turn2Scope, '我记得你喜欢红茶。'), context2, 'turn-insp-2:user', signal());

  // 3. Inspect context: ManagementMemoryPort must return the ACTUAL consumed snapshot
  const inspected = await mgmtPort.context('companion', '红茶');
  assert.ok(inspected.inspection, 'Inspection metadata must be present');
  assert.equal(inspected.inspection?.isIssuedSnapshot, true, 'Must report actual issued snapshot');
  assert.equal(inspected.inspection?.turnId, 'turn-insp-2', 'Must match actual turnId');
  assert.equal(inspected.inspection?.isStale, false, 'Freshly consumed context is not stale');

  // Verify candidates breakdown
  const candidates = inspected.inspection?.candidates ?? [];
  assert.ok(candidates.length > 0, 'Candidates list must be populated');
  const recalledCandidate = candidates.find(c => c.id === recalledId);
  assert.ok(recalledCandidate, 'Recalled memory must be in candidate list');
  assert.equal(recalledCandidate?.selected, true, 'Recalled memory was selected');
  assert.ok(recalledCandidate?.score > 0, 'Recalled memory had positive score');

  // 4. Stale Safety: Now invalidate the memory by updating or deleting it
  mgmtPort.edit({
    characterId: 'companion',
    id: recalledId,
    expectedVersion: 1,
    operationId: 'edit-inval-1',
    text: '用户其实不喜欢喝红茶，改喝绿茶了。',
    reason: '用户纠正',
  });

  // Re-inspect: Inspector MUST detect that the previously issued context is now STALE!
  const staleInspection = await mgmtPort.context('companion', '红茶');
  assert.equal(staleInspection.inspection?.isIssuedSnapshot, true);
  assert.equal(staleInspection.inspection?.isStale, true, 'Must detect invalidated context sources');
  assert.ok(staleInspection.inspection?.staleSourceIds?.includes(recalledId), 'Must identify which source became stale');
  assert.equal(staleInspection.inspection?.status, 'invalidated');
  assert.ok(staleInspection.note.includes('失效') || staleInspection.note.includes('纠正'));
});
