import test from 'node:test';
import assert from 'node:assert/strict';
import { TurnController } from '../../core/turn-controller.js';
const at = new Date().toISOString();
test('text does not enter speaking until actual playback, and ignores early amplitude', () => {
  const c = new TurnController(); const {input} = c.begin('text', 'hi');
  assert.equal(c.snapshot()?.state, 'thinking');
  assert.equal(c.playback({scope: input.scope, at, type: 'amplitude', value: .7}), false);
  c.playback({scope: input.scope, at, type: 'started', audioId: 'audio'});
  c.playback({scope: input.scope, at, type: 'amplitude', value: .7});
  assert.equal(c.snapshot()?.mouth, .7);
});
test('cancel aborts old work, resets mouth and rejects late playback in a new turn', () => {
  const c = new TurnController(); const old = c.begin('voice');
  c.playback({scope: old.input.scope, at, type: 'started', audioId: 'old'});
  c.playback({scope: old.input.scope, at, type: 'amplitude', value: .8});
  const current = c.begin('text', 'new');
  assert.equal(old.signal.aborted, true);
  assert.equal(c.playback({scope: old.input.scope, at, type: 'ended'}), false);
  assert.equal(c.snapshot()?.mouth, 0);
  assert.equal(c.accepts(current.input.scope), true);
});
test('new session invalidates foreground and preserves immutable companion turn scope', () => {
  const c = new TurnController(); const old = c.begin('text');
  c.resetSession(); const current = c.begin('text');
  assert.equal(old.signal.aborted, true);
  assert.equal(old.input.scope.characterId, 'companion');
  assert.equal(current.input.scope.characterId, 'companion');
  assert.notEqual(old.input.scope.sessionId, current.input.scope.sessionId);
  assert.equal(c.accepts(old.input.scope), false);
});
for (const type of ['ended', 'stopped', 'error'] as const) test(`${type} closes mouth and rejects same-turn late start/amplitude`, () => {
  const c = new TurnController(); const {input} = c.begin('text');
  c.playback({scope: input.scope, at, type: 'started', audioId: 'audio'});
  c.playback({scope: input.scope, at, type: 'amplitude', value: .8});
  c.playback(type === 'error' ? {scope: input.scope, at, type, message: 'failed'} : {scope: input.scope, at, type});
  assert.equal(c.snapshot()?.mouth, 0);
  assert.equal(c.playback({scope: input.scope, at, type: 'started', audioId: 'late'}), false);
  assert.equal(c.playback({scope: input.scope, at, type: 'amplitude', value: .9}), false);
});

test('normal playback completion invalidates events without firing cancellation at the player', () => {
  const c = new TurnController(); const {input, signal} = c.begin('text');
  c.playback({scope: input.scope, at, type: 'started', audioId: 'audio'});
  c.playback({scope: input.scope, at, type: 'ended'});
  assert.equal(signal.aborted, false);
  assert.equal(c.accepts(input.scope), false);
});
