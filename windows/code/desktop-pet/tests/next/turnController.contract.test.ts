// Characterization of upstream TurnController/sameScope: scope identity, cancel-on-new-turn, terminal playback semantics.
import test from 'node:test';
import assert from 'node:assert/strict';
import { COMPANION_ID } from '../../contracts/character.js';
import type { PlaybackEvent, TurnScope } from '../../contracts/index.js';
import { sameScope, TurnController } from '../../core/turn-controller.js';
import { nextScope } from './harness.js';

test('sameScope compares every scope field', () => {
  const base = nextScope('turn-1');
  assert.ok(sameScope(base, { ...base }));
  assert.ok(!sameScope(base, { ...base, characterId: 'other' }));
  assert.ok(!sameScope(base, { ...base, sessionId: 'session-b' }));
  assert.ok(!sameScope(base, { ...base, turnId: 'turn-2' }));
  assert.ok(!sameScope(base, { ...base, generation: base.generation + 1 }));
});

test('a new submission cancels the previous active turn and bumps the generation', () => {
  const controller = new TurnController();
  const first = controller.begin('text', '第一条');
  const firstScope = first.input.scope;
  assert.ok(controller.accepts(firstScope));

  const second = controller.begin('text', '第二条');
  assert.ok(first.signal.aborted, 'previous turn signal must abort when a new turn begins');
  assert.ok(!controller.accepts(firstScope), 'stale scope is no longer accepted');
  assert.ok(controller.accepts(second.input.scope));
  assert.equal(second.input.scope.generation, firstScope.generation + 1);
  assert.equal(second.input.scope.sessionId, firstScope.sessionId);
  assert.equal(controller.identity().characterId, COMPANION_ID);
});

test('explicit cancel aborts and invalidates the current scope; a later retry gets a fresh generation', () => {
  const controller = new TurnController();
  const { input, signal } = controller.begin('text', '会被取消');
  controller.cancel();
  assert.ok(signal.aborted);
  assert.ok(!controller.accepts(input.scope));
  const retry = controller.begin('text', '重试');
  assert.ok(retry.input.scope.generation > input.scope.generation, 'retry must run under a strictly newer generation (begin itself bumps again after an explicit cancel)');
});

test('terminal playback events consume the turn exactly once; later events are filtered', () => {
  const controller = new TurnController();
  const { input } = controller.begin('voice');
  const scope = input.scope;
  const event = (type: 'started' | 'ended' | 'stopped'): PlaybackEvent => {
    if (type === 'started') return { scope, at: '2026-09-19T00:00:00.000Z', type, audioId: 'a' };
    return { scope, at: '2026-09-19T00:00:00.000Z', type };
  };

  assert.ok(controller.playback(event('started')));
  assert.ok(controller.playback({ scope, at: '2026-09-19T00:00:00.000Z', type: 'amplitude', value: 0.5 }));
  assert.ok(controller.playback(event('ended')), 'ended must be accepted once');
  assert.ok(!controller.accepts(scope), 'terminal event consumes the turn');
  assert.ok(!controller.playback(event('ended')), 'a second terminal event for the same scope is rejected');
});

test('stop and error abort the active controller so in-flight work sees cancellation', () => {
  for (const type of ['stopped', 'error'] as const) {
    const controller = new TurnController();
    const { input, signal } = controller.begin('voice');
    const event = { scope: input.scope, at: '2026-09-19T00:00:00.000Z', type, ...(type === 'error' ? { message: 'boom' } : {}) } as PlaybackEvent;
    assert.ok(controller.playback(event));
    assert.ok(signal.aborted, `${type} must abort the active turn`);
    assert.ok(!controller.accepts(input.scope));
  }
});

test('events from another scope never touch the active turn', () => {
  const controller = new TurnController();
  const { input } = controller.begin('voice');
  const foreign: TurnScope = { ...input.scope, turnId: 'other-turn', generation: input.scope.generation + 5 };
  assert.ok(!controller.playback({ scope: foreign, at: '2026-09-19T00:00:00.000Z', type: 'started', audioId: 'a' }));
  assert.ok(controller.accepts(input.scope), 'foreign-scope events must not consume the turn');
});

test('amplitude is rejected before playback actually started', () => {
  const controller = new TurnController();
  const { input } = controller.begin('voice');
  assert.ok(!controller.playback({ scope: input.scope, at: '2026-09-19T00:00:00.000Z', type: 'amplitude', value: 0.9 }));
});

test('finish completes a text turn without inventing playback, and presentation snapshot is a copy', () => {
  const controller = new TurnController();
  const { input } = controller.begin('text', '文字轮');
  assert.ok(controller.thinking(input.scope));
  const first = controller.snapshot();
  const second = controller.snapshot();
  assert.ok(first && second);
  assert.notEqual(first, second, 'snapshot hands out copies, not the live presentation object');
  assert.deepEqual(first, second, 'successive snapshots match while state is unchanged');
  assert.ok(controller.finish(input.scope));
  assert.ok(!controller.accepts(input.scope));
  assert.ok(!controller.finish(input.scope), 'finish is idempotent and refuses stale scopes');
});

test('resetSession rotates the session identity so cross-session scopes cannot match', () => {
  const controller = new TurnController();
  const before = controller.identity().sessionId;
  const { input, signal } = controller.begin('text', '旧会话');
  controller.resetSession();
  assert.notEqual(controller.identity().sessionId, before);
  assert.ok(signal.aborted, 'resetSession must cancel the active turn');
  assert.ok(!controller.accepts(input.scope));
});
