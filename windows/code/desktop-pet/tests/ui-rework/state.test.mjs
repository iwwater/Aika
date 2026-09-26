import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createStatusBadge,
  LIFECYCLE_STATUSES,
  createEpochGuard,
  createConfigEnvelope
} from '../../management/ui/envelope.mjs';

test('UIR-01 State: status badge distinguishes non-ready states from ready', () => {
  const statuses = ['ready', 'loading', 'failed', 'pendingRestart', 'unavailable', 'disabled', 'unknown'];
  for (const s of statuses) {
    const badge = createStatusBadge(s);
    assert.equal(badge.getAttribute('data-lifecycle-status'), s);
    assert.ok(badge.className.includes(`status-${s}`));
    assert.ok(badge.textContent.length > 0);
  }
  // Verify it does not default pendingRestart or unavailable to 'success'
  assert.equal(LIFECYCLE_STATUSES.pendingRestart.tone, 'warning');
  assert.equal(LIFECYCLE_STATUSES.failed.tone, 'error');
  assert.equal(LIFECYCLE_STATUSES.unavailable.tone, 'muted');
});

test('UIR-01 State: epoch guard prevents stale async responses across navigation', () => {
  const guard = createEpochGuard();

  const req1 = guard.next();
  assert.equal(req1.epoch, 1);
  assert.equal(guard.isCurrent(1), true);

  // User rapidly clicks to another tab or character
  const req2 = guard.next();
  assert.equal(req2.epoch, 2);
  assert.equal(req1.signal.aborted, true); // req1 was cancelled
  assert.equal(guard.isCurrent(1), false); // req1 response will be ignored
  assert.equal(guard.isCurrent(2), true);
});

test('UIR-01 State: config envelope tracks revisions and preserves draft on 409 conflict', () => {
  const envelope = createConfigEnvelope({
    owner: 'character',
    scope: 'alice',
    initialData: { persona: 'Original persona text' },
    initialSavedRevision: 1,
    initialEffectiveRevision: 1,
  });

  assert.equal(envelope.isDirty(), false);

  // User edits form
  envelope.updateDraft({ persona: 'Updated new draft text' });
  assert.equal(envelope.isDirty(), true);
  assert.equal(envelope.getDraft().persona, 'Updated new draft text');
  assert.equal(envelope.getData().persona, 'Original persona text');

  // Simulate server returns 409 conflict with remote concurrent modification
  envelope.onSaveConflict({
    latestServerData: { persona: 'Remote modified by another window' },
    latestServerRevision: 2,
  });

  assert.equal(envelope.isConflicted(), true);
  // Draft MUST NOT be wiped out!
  assert.equal(envelope.getDraft().persona, 'Updated new draft text');
  assert.equal(envelope.getConflictSnapshot().serverData.persona, 'Remote modified by another window');

  // User can review and resolve, e.g. accept draft and succeed
  envelope.onSaveSuccess({ newSavedRevision: 3, pendingRestart: true });
  assert.equal(envelope.isConflicted(), false);
  assert.equal(envelope.getSavedRevision(), 3);
  assert.equal(envelope.getAvailability(), 'pendingRestart');
  assert.equal(envelope.getData().persona, 'Updated new draft text');
  assert.equal(envelope.isDirty(), false);
});
