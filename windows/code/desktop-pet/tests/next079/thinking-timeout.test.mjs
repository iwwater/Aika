import test from 'node:test';
import assert from 'node:assert/strict';
import { ThinkingTimeout } from '../../desktop/thinking-timeout.mjs';

function fakeTimers() {
  let nextId = 0;
  const callbacks = new Map();
  const cleared = new Set();
  return {
    callbacks,
    cleared,
    setTimer(callback, delay) { const id = ++nextId; callbacks.set(id, { callback, delay }); return id; },
    clearTimer(id) { cleared.add(id); },
    fire(id) { callbacks.get(id)?.callback(); },
  };
}

test('N079-07 the production thinking timeout fires once at 40 seconds for the current turn', () => {
  const timers = fakeTimers();
  const timeout = new ThinkingTimeout({ timeoutMs: 40000, setTimer: timers.setTimer, clearTimer: timers.clearTimer });
  let current = true, cancelled = 0;
  timeout.start(() => current, () => { cancelled++; });
  assert.equal(timers.callbacks.get(1)?.delay, 40000);
  assert.equal(cancelled, 0, 'the request remains live before the timer fires');
  timers.fire(1);
  timers.fire(1);
  assert.equal(cancelled, 1, 'a timeout can cancel only once');
});

test('N079-07 a queued old timeout cannot cancel a newer turn after stop or restart', () => {
  const timers = fakeTimers();
  const timeout = new ThinkingTimeout({ timeoutMs: 40000, setTimer: timers.setTimer, clearTimer: timers.clearTimer });
  let cancelled = '';
  timeout.start(() => true, () => { cancelled = 'old'; });
  timeout.stop();
  timeout.start(() => true, () => { cancelled = 'new'; });

  // Simulate a timer callback already queued by the runtime before clearTimeout took effect.
  timers.fire(1);
  assert.equal(cancelled, '', 'stopped timer callback is generation-invalidated');
  timers.fire(2);
  assert.equal(cancelled, 'new');
});

test('N079-07 a timed-out request that no longer owns the thinking view is left alone', () => {
  const timers = fakeTimers();
  const timeout = new ThinkingTimeout({ setTimer: timers.setTimer, clearTimer: timers.clearTimer });
  let current = true, cancelled = 0;
  timeout.start(() => current, () => { cancelled++; });
  current = false;
  timers.fire(1);
  assert.equal(cancelled, 0, 'scope/request ownership is checked when the callback runs');
});
