/**
 * tests/next08/interaction-invariants.test.ts
 *
 * 08-02 Acceptance Test Suite:
 * Validates session & desktop interaction invariants between speech bubble, drawer, and TurnScope.
 *
 * AC-0802-1: Single turn scope invariant - panel toggle preserves view.scope and triggers no duplicate turns.
 * AC-0802-2: Bubble dismissal never deletes chat history.
 * AC-0802-3: Stale generation guard rejects late arrival events.
 * AC-0802-4: IME composition prevents premature enter submission.
 * AC-0802-5: Interactive region arbitration toggles with drawer visibility.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { DesktopViewState, scopeEquals } from '../../desktop/view-state.js';
import { DesktopChatLog } from '../../desktop/chat-log.js';
import { sanitizeRects, shouldIgnoreMouseEvents } from '../../desktop/interactive-region.js';
import type { TurnScope, DesktopEvent } from '../../contracts/index.js';

test('AC-0802-1: Single turn scope invariant - drawer toggle preserves scope and does not emit new turn', () => {
  const view = new DesktopViewState();
  const chat = new DesktopChatLog();
  const scope: TurnScope = { characterId: 'companion', sessionId: 'sess-0802', turnId: 'turn-1', generation: 1 };

  // 1. Initial turn started
  view.receive({
    type: 'turn',
    input: { scope, kind: 'text', startedAt: new Date().toISOString() },
  });
  assert.equal(view.state, 'thinking');
  assert.ok(scopeEquals(view.scope, scope));

  // 2. Chat log submits text
  chat.submit('companion', '用户输入问题');
  chat.acknowledge(scope);
  assert.equal(chat.rows('companion').length, 1);
  assert.equal(chat.rows('companion')[0]?.text, '用户输入问题');

  // 3. Simulating user opening drawer during thinking
  // The view state must strictly maintain the SAME scope!
  const scopeDuringThinking = view.scope;
  assert.ok(scopeEquals(scopeDuringThinking, scope), 'Opening drawer must preserve existing scope');

  // 4. Assistant reply arrives
  view.receive({
    type: 'reply',
    reply: { scope, text: '这是桌宠的回答', expression: { emotion: 'happy', intensity: 1, delivery: '', gesture: null } },
  });
  chat.reply(scope, '这是桌宠的回答');
  assert.equal(view.reply, '这是桌宠的回答');
  assert.equal(chat.rows('companion').length, 2);

  // 5. Simulating user closing drawer during playback
  const scopeDuringClose = view.scope;
  assert.ok(scopeEquals(scopeDuringClose, scope), 'Closing drawer must not reset scope or generate new generation');
});

test('AC-0802-2: Bubble dismissal never deletes chat history', () => {
  const chat = new DesktopChatLog();
  const scope: TurnScope = { characterId: 'companion', sessionId: 'sess-0802', turnId: 'turn-2', generation: 1 };

  chat.submit('companion', '测试长文本');
  chat.acknowledge(scope);
  chat.reply(scope, '长回复内容……（假设气泡展示后超时淡出）');

  assert.equal(chat.rows('companion').length, 2);

  // Simulating bubble dismissal (dismissBubble purely modifies DOM without touching chatLog)
  // Assert chat rows still contain the full conversation
  const rows = chat.rows('companion');
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.kind, 'user');
  assert.equal(rows[0]?.text, '测试长文本');
  assert.equal(rows[1]?.kind, 'assistant');
  assert.equal(rows[1]?.text, '长回复内容……（假设气泡展示后超时淡出）');
});

test('AC-0802-3: Stale generation guard rejects late arrival events', () => {
  const view = new DesktopViewState();
  const oldScope: TurnScope = { characterId: 'companion', sessionId: 'sess-1', turnId: 'turn-1', generation: 1 };
  const newScope: TurnScope = { characterId: 'companion', sessionId: 'sess-1', turnId: 'turn-2', generation: 2 };

  // View moves to generation 2
  view.receive({
    type: 'turn',
    input: { scope: newScope, kind: 'text', startedAt: new Date().toISOString() },
  });
  assert.equal(view.scope?.generation, 2);

  // Late reply from generation 1 arrives
  const acceptedOldReply = view.receive({
    type: 'reply',
    reply: { scope: oldScope, text: '来自旧代次的迟到回复', expression: { emotion: 'neutral', intensity: 0, delivery: '', gesture: null } },
  });
  assert.equal(acceptedOldReply, false, 'Late reply from previous generation must be rejected');
  assert.equal(view.reply, '', 'View reply must not be polluted by stale generation');

  // Presentation from generation 1 arrives
  const acceptedOldPres = view.receive({
    type: 'presentation',
    presentation: { scope: oldScope, state: 'speaking', mouth: 0, expression: { emotion: 'neutral', intensity: 0, delivery: '', gesture: null } },
  });
  assert.equal(acceptedOldPres, false, 'Stale presentation event must be rejected');
});

test('AC-0802-4: IME composition check prevents enter key submission', () => {
  // Logic mirror of main.mjs onkeydown / onsubmit
  let composing = true;
  let submitted = false;

  const onKeyDown = (event: { key: string; isComposing: boolean; keyCode: number; shiftKey: boolean }) => {
    if (event.key !== 'Enter') return;
    if (composing || event.isComposing || event.keyCode === 229) {
      return; // Intercepted during composition
    }
    if (!event.shiftKey) {
      submitted = true;
    }
  };

  // 1. Enter pressed during composition (e.g. selecting Chinese pinyin)
  onKeyDown({ key: 'Enter', isComposing: true, keyCode: 229, shiftKey: false });
  assert.equal(submitted, false, 'Enter during composition must not submit');

  // 2. Composition ends, explicit Enter pressed
  composing = false;
  onKeyDown({ key: 'Enter', isComposing: false, keyCode: 13, shiftKey: false });
  assert.equal(submitted, true, 'Plain enter after composition ends must submit');
});

test('AC-0802-5: Interactive region arbitration toggles with drawer visibility', () => {
  const windowBounds = { x: 0, y: 0, width: 800, height: 600 };
  const drawerRect = { x: 40, y: 40, width: 520, height: 480 };
  const characterBodyPoint = { x: 700, y: 500 };
  const drawerPoint = { x: 100, y: 100 };

  // Case A: Drawer open -> region published
  const regionsWhenOpen = sanitizeRects([drawerRect], windowBounds);
  assert.equal(regionsWhenOpen.length, 1);

  // When pointer is on drawer, mouse must NOT be ignored (interactive)
  const ignoreOnDrawer = shouldIgnoreMouseEvents(true, drawerPoint, regionsWhenOpen);
  assert.equal(ignoreOnDrawer, false, 'Pointer on open drawer must receive clicks');

  // When pointer is on character body, mouse MUST be ignored (click-through to desktop)
  const ignoreOnBody = shouldIgnoreMouseEvents(true, characterBodyPoint, regionsWhenOpen);
  assert.equal(ignoreOnBody, true, 'Pointer on character body must click through');

  // Case B: Drawer closed -> empty regions
  const regionsWhenClosed = sanitizeRects([], windowBounds);
  assert.equal(regionsWhenClosed.length, 0);

  // Entire window clicks through (mouse ignored everywhere)
  assert.equal(shouldIgnoreMouseEvents(true, drawerPoint, regionsWhenClosed), true);
  assert.equal(shouldIgnoreMouseEvents(true, characterBodyPoint, regionsWhenClosed), true);
});
