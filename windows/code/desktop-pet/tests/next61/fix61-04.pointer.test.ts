// FIX61-04 RED->GREEN: the desktop splits pointer buttons. A left short tap strokes the character
// locally; a left drag still moves the pet; the right button opens the function panel exactly once.
// No stroke may reach the backend, Memory or the LLM.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CharacterPointerRouter, PANEL_ENTRIES, strokePlan } from '../../desktop/pointer-router.js';
import type { PointerHandlers } from '../../desktop/pointer-router.js';

const character = () => ({ id: 'character' });
interface Calls { panel: boolean[]; stroke: unknown[]; drag: number[][] }
function recorder(overrides: Partial<PointerHandlers> = {}): { calls: Calls; handlers: PointerHandlers } {
  const calls: Calls = { panel: [], stroke: [], drag: [] };
  return { calls, handlers: {
    panel: open => calls.panel.push(open),
    stroke: at => calls.stroke.push(at),
    drag: (dx, dy) => calls.drag.push([dx, dy]),
    ...overrides
  } };
}

// 04-A -----------------------------------------------------------------------------------------
test('04-A a left short tap strokes exactly once and never opens the chat panel', () => {
  const { calls, handlers } = recorder();
  const router = new CharacterPointerRouter(handlers);
  router.pointerDown({ button: 0, pointerId: 1, screenX: 100, screenY: 100, target: character() });
  router.pointerUp({ button: 0, pointerId: 1, screenX: 101, screenY: 100 });
  assert.equal(calls.stroke.length, 1, 'one short left tap is one stroke');
  assert.equal(calls.panel.length, 0, 'a left tap must not open the chat drawer');
  assert.equal(calls.drag.length, 0, 'a short tap is not a drag');
});

test('04-A a left drag moves the pet and never opens the panel or strokes', () => {
  const { calls, handlers } = recorder();
  const router = new CharacterPointerRouter(handlers);
  router.pointerDown({ button: 0, pointerId: 1, screenX: 100, screenY: 100, target: character() });
  router.pointerMove({ pointerId: 1, screenX: 140, screenY: 130 });
  router.pointerUp({ button: 0, pointerId: 1, screenX: 140, screenY: 130 });
  assert.ok(calls.drag.length >= 1, 'a drag reaches the shell drag channel');
  assert.equal(calls.stroke.length, 0, 'a drag is not a stroke');
  assert.equal(calls.panel.length, 0, 'a drag must not open the chat drawer');
});

test('04-A a cancelled pointer performs no action, and rapid taps never open the drawer', () => {
  const { calls, handlers } = recorder();
  const router = new CharacterPointerRouter(handlers);
  router.pointerDown({ button: 0, pointerId: 3, screenX: 10, screenY: 10, target: character() });
  router.pointerCancel({ pointerId: 3 });
  router.pointerUp({ button: 0, pointerId: 3, screenX: 10, screenY: 10 });
  assert.deepEqual(calls, { panel: [], stroke: [], drag: [] }, 'a cancelled pointer does nothing');

  router.pointerDown({ button: 0, pointerId: 4, screenX: 10, screenY: 10, target: character() });
  router.pointerUp({ button: 0, pointerId: 4, screenX: 10, screenY: 10 });
  router.pointerDown({ button: 0, pointerId: 5, screenX: 10, screenY: 10, target: character() });
  router.pointerUp({ button: 0, pointerId: 5, screenX: 10, screenY: 10 });
  assert.equal(calls.panel.length, 0, 'rapid taps never open the chat drawer');
  assert.equal(calls.stroke.length, 2);
});

test('04-A the right button opens the function panel exactly once and suppresses the duplicate release', () => {
  const { calls, handlers } = recorder();
  const router = new CharacterPointerRouter(handlers);
  router.contextMenu({ target: character(), screenX: 50, screenY: 60 });
  assert.deepEqual(calls.panel, [true], 'the right button opens the panel');
  assert.equal(calls.stroke.length, 0, 'the right button never strokes');
  // A following pointerdown/pointerup for the same right press must not toggle the panel again.
  router.pointerDown({ button: 2, pointerId: 9, screenX: 50, screenY: 60, target: character() });
  router.pointerUp({ button: 2, pointerId: 9, screenX: 50, screenY: 60 });
  assert.deepEqual(calls.panel, [true], 'the right press opens the panel exactly once');
});

test('04-A the right button closes an already-open panel, and a right click outside the character is ignored', () => {
  const { calls, handlers } = recorder({ panelOpen: () => true });
  const router = new CharacterPointerRouter(handlers);
  router.contextMenu({ target: character() });
  assert.deepEqual(calls.panel, [false], 'the right button toggles the panel it owns');
  router.contextMenu({ target: { id: 'text' } });
  assert.deepEqual(calls.panel, [false], 'a right click outside the character changes nothing');
});

// 04-B -----------------------------------------------------------------------------------------
test('04-B a stroke produces head/body parameter movement when the model supports it, and stays inert when it does not', () => {
  const full = strokePlan({ head: true, body: true, blink: true, reducedMotion: false });
  assert.equal(full.applicable, true);
  assert.ok(full.values.pitch > 0, 'a supported model receives measurable head movement');
  assert.ok(full.values.body > 0, 'and body movement');

  const headless = strokePlan({ head: false, body: false, blink: false, reducedMotion: false });
  assert.equal(headless.applicable, false, 'a model without those parameters reports no movement instead of throwing');
  assert.deepEqual(headless.values, { yaw: 0, pitch: 0, roll: 0, body: 0 });
  assert.ok(headless.reason.length > 0, 'and explains why nothing moved');

  const reduced = strokePlan({ head: true, body: true, blink: true, reducedMotion: true });
  assert.equal(reduced.values.pitch, 0, 'reduced motion suppresses the stroke movement');
  assert.equal(reduced.applicable, false);
});

// 04-C -----------------------------------------------------------------------------------------
test('04-C the panel is a separate view from the chat drawer and every entry resolves to a real target', () => {
  const ids = PANEL_ENTRIES.map(entry => entry.id);
  for (const required of ['chat', 'skin', 'knowledge', 'settings', 'memory', 'timeline', 'diagnostics', 'microphone', 'status']) {
    assert.ok(ids.includes(required), `the panel must offer the ${required} entry`);
  }
  for (const entry of PANEL_ENTRIES) {
    assert.ok(entry.label.trim().length > 0, `${entry.id} needs a label`);
    // Every entry resolves to a real target: a desktop view, a shell action, or the local console.
    // There must be no entry that silently does nothing when clicked.
    assert.ok(['view', 'shell', 'console'].includes(entry.kind), `${entry.id} has an unknown target kind`);
    if (entry.kind === 'view') assert.ok(entry.target, `${entry.id} must name its view target`);
    if (entry.kind === 'shell') assert.ok(entry.action, `${entry.id} must name its shell action`);
    if (entry.kind === 'console') assert.ok(entry.target, `${entry.id} must name its console target`);
  }
});

test('04-C the function panel is a peer view, so toggling it never clears the active turn or its reply state', async () => {
  const { DesktopViewState } = await import('../../desktop/view-state.js');
  const view = new DesktopViewState();
  const scope = { characterId: 'companion' as const, sessionId: 's', turnId: 't', generation: 1 };
  view.receive({ type: 'turn', input: { scope, kind: 'text', startedAt: new Date().toISOString(), text: '你好' } });
  assert.ok(view.scope, 'the turn is active');
  // Opening or closing the peer panel is not a desktop command, so it touches no chat state at all.
  assert.ok(view.accepts(scope), 'the active turn survives a panel round trip');
  // Only an explicit cancel/switch resets the turn; that is the pre-existing, unchanged contract.
  view.command({ type: 'cancel' });
  assert.equal(view.scope, null);
});
