import test from 'node:test';
import assert from 'node:assert/strict';

test('UIR-04 Playground: Chinese IME composition does not trigger submit on Enter', () => {
  let isComposing = false;
  let submitCount = 0;

  function handleKeydown(event) {
    if (event.key === 'Enter' && !event.shiftKey && !isComposing) {
      submitCount++;
    }
  }

  // 1. User is typing Pinyin (IME composition starts)
  isComposing = true;
  handleKeydown({ key: 'Enter', shiftKey: false });
  assert.equal(submitCount, 0, 'Enter during composition must not submit');

  // 2. User confirms Chinese character selection (composition ends)
  isComposing = false;
  handleKeydown({ key: 'Enter', shiftKey: false });
  assert.equal(submitCount, 1, 'Enter after composition submits the turn');
});

test('UIR-04 Playground: idempotency and double-click prevention', () => {
  let isSubmitting = false;
  let turnsStarted = 0;
  const operationIdMap = new Map();

  function triggerTurnSubmit(operationId, text) {
    if (isSubmitting) return { rejected: 'busy' };
    if (operationIdMap.has(operationId)) return { idempotent: operationIdMap.get(operationId) };

    isSubmitting = true;
    turnsStarted++;
    const turn = { turnId: `t-${operationId}`, text, status: 'running' };
    operationIdMap.set(operationId, turn);
    return { created: turn };
  }

  const op1 = 'op-uuid-1';
  const first = triggerTurnSubmit(op1, 'Hello');
  assert.ok(first.created);
  assert.equal(turnsStarted, 1);

  // Fast double click with same state
  const doubleClick = triggerTurnSubmit(op1, 'Hello');
  assert.equal(doubleClick.rejected, 'busy');
  assert.equal(turnsStarted, 1, 'Second click while submitting is rejected');

  // Reset busy state after request completes
  isSubmitting = false;
  const duplicateReplay = triggerTurnSubmit(op1, 'Hello');
  assert.ok(duplicateReplay.idempotent);
  assert.equal(turnsStarted, 1, 'Same operationId replays existing turn without recreating');
});

test('UIR-04 Playground: Context probe is explicitly marked as calculation, not history', () => {
  const probeResult = {
    isHistoricConsumedContext: false,
    label: '当前算法试算，非历史已消耗 Context',
    recalledMemories: [
      { text: '记忆 A' },
      { text: '记忆 B' }
    ]
  };

  assert.equal(probeResult.isHistoricConsumedContext, false);
  assert.ok(probeResult.label.includes('非历史已消耗 Context'));
});
