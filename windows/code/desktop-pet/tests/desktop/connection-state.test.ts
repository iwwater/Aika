import test from 'node:test';
import assert from 'node:assert/strict';
import { DesktopConnectionState } from '../../desktop/view-state.js';

// FIX61-03 03-D: the shell forwards typed backend_startup progress with its connection states.
// The cast documents the wire shape; before the fix these fields did not exist and were dropped.
const wire = (value: Record<string, unknown>) => value as unknown as Parameters<DesktopConnectionState['update']>[0];
const startupOf = (c: DesktopConnectionState) =>
  c as unknown as { phase: string | null; sequence: number; completed: number; total: number | null; elapsedMs: number | null };

test('startup progress stays visible while connecting and clears on failure', () => {
  const c = new DesktopConnectionState();
  assert.equal(c.update(wire({ generation: 1, state: 'connecting', canRetry: true,
    phase: 'verifying', sequence: 3, completed: 30, total: 90, elapsedMs: 4200 })), true);
  const s = startupOf(c);
  assert.equal(s.phase, 'verifying'); assert.equal(s.sequence, 3);
  assert.equal(s.completed, 30); assert.equal(s.total, 90); assert.equal(s.elapsedMs, 4200);
  // A repeated heartbeat record is still a valid connecting state; it must not be rejected,
  // and it must not change the displayed progress.
  assert.equal(c.update(wire({ generation: 1, state: 'connecting', canRetry: true,
    phase: 'verifying', sequence: 3, completed: 30, total: 90, elapsedMs: 4300 })), true);
  assert.equal(s.sequence, 3); assert.equal(s.completed, 30);
  // A newer generation without a total resets the ratio but keeps the reported phase.
  assert.equal(c.update(wire({ generation: 2, state: 'connecting', canRetry: true, phase: 'initializing' })), true);
  assert.equal(s.phase, 'initializing'); assert.equal(s.sequence, 0);
  assert.equal(s.completed, 0); assert.equal(s.total, null);
  assert.equal(c.update(wire({ generation: 2, state: 'failed', reason: 'stalled', canRetry: true })), true);
  assert.equal(s.phase, null, 'a terminal state leaves no startup progress behind');
  assert.equal(c.reason, 'stalled');
});

test('ready clears the startup display and stale generations are still rejected', () => {
  const c = new DesktopConnectionState();
  c.update(wire({ generation: 1, state: 'connecting', canRetry: true, phase: 'verifying', sequence: 2, completed: 10, total: 20 }));
  assert.equal(c.update(wire({ generation: 1, state: 'connecting', canRetry: true, phase: 'ready' })), true);
  assert.equal(c.ready(1), true);
  const s = startupOf(c);
  assert.equal(s.phase, null); assert.equal(c.state, 'ready'); assert.equal(c.reason, '');

  const d = new DesktopConnectionState();
  d.update(wire({ generation: 1, state: 'connecting', canRetry: true, phase: 'verifying', sequence: 1, completed: 1, total: 4 }));
  // Same-generation connecting records are live progress of the visible attempt, as the shell
  // forwards them; they refresh the display instead of being rejected.
  assert.equal(d.update(wire({ generation: 1, state: 'connecting', canRetry: true, phase: 'verifying', sequence: 2, completed: 2, total: 4 })), true);
  const shown = startupOf(d);
  assert.equal(shown.sequence, 2);
  // An older generation stays rejected and cannot touch the visible progress.
  d.update(wire({ generation: 3, state: 'connecting', canRetry: true, phase: 'starting' }));
  assert.equal(d.update(wire({ generation: 1, state: 'connecting', canRetry: true, phase: 'verifying', sequence: 9, completed: 9 })), false,
    'an older generation cannot re-connect');
  const rejected = startupOf(d);
  assert.equal(rejected.phase, 'starting', 'a rejected record never leaves its progress behind');
  assert.equal(rejected.sequence, 0);

  // A failed attempt cannot be revived by a replayed connecting record from its own generation,
  // but a fresh retry with a strictly newer generation always can.
  d.update(wire({ generation: 3, state: 'failed', reason: 'stalled', canRetry: true }));
  assert.equal(d.update(wire({ generation: 3, state: 'connecting', canRetry: true })), false);
  assert.equal(d.state, 'failed');
  assert.equal(d.update(wire({ generation: 4, state: 'connecting', canRetry: true })), true);
  assert.equal(d.state, 'connecting');
});
