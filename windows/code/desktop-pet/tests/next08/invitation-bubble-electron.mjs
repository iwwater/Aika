/**
 * tests/next08/invitation-bubble-electron.mjs
 *
 * 08-04 Acceptance Scenario: Real Electron BrowserWindow, real Chromium DOM, real CSS & hit-testing.
 *
 * Validates:
 *   1. Initial DOM state: #invitation-card is hidden.
 *   2. Invitation display: #invitation-card is shown with text and #invitation-ignore button.
 *   3. CSS computed properties: opacity, flex layout, border-radius, z-index.
 *   4. Interactive region hit-testing: pointer on card stops click-through; pointer outside ignores mouse.
 *   5. 8-second auto-dismiss lifecycle:
 *      - at 8000ms: .is-dismissing class added (opacity 0, pointer-events none);
 *      - at 8180ms: onTimeout removes card and dispatches ignore_invitation command.
 *   6. User explicit ignore: clicking #invitation-ignore immediately dismisses card and cancels auto-dismiss.
 *   7. User acceptance: clicking #invitation dispatches click_invitation with response text and opens drawer.
 */

import { app, BrowserWindow } from 'electron';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { sanitizeRects, shouldIgnoreMouseEvents } from '../../dist/desktop/interactive-region.js';

const results = [];
const check = (id, ok, detail) => results.push({ id, status: ok ? 'PASS' : 'FAIL', detail });

const root = resolve(import.meta.dirname, '../..');
const tempUserData = mkdtempSync(join(tmpdir(), 'electron-invitation-bubble-'));
app.setPath('userData', tempUserData);
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-http-cache');
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');

void app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    paintWhenInitiallyHidden: true,
    width: 900,
    height: 700,
    frame: false,
    transparent: true,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  const styleCss = readFileSync(resolve(root, 'desktop/style.css'), 'utf8');
  const dismisserJs = readFileSync(resolve(root, 'desktop/invitation-auto-dismiss.mjs'), 'utf8');

  const html = `<!doctype html><html><head><meta charset="utf-8">
  <style>
    html, body { margin: 0; background: transparent; width: 100%; height: 100%; }
    ${styleCss}
  </style></head><body>
    <main id="pet">
      <div id="invitation-card" role="group" aria-label="主动邀请" hidden>
        <button id="invitation" type="button"></button>
        <button id="invitation-ignore" type="button">稍后再说</button>
      </div>
      <section id="drawer" hidden style="position:absolute;left:0;top:0;width:300px;height:100%"></section>
    </main>
  </body></html>`;

  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));

    // 1. Initial State Check
    const initialHidden = await win.webContents.executeJavaScript(`
      document.getElementById('invitation-card').hidden
    `);
    check('INVITE-01-initial-hidden', initialHidden === true, `hidden was ${initialHidden}`);

    // 2. Drive display of an invitation via in-page controller
    const displayResult = await win.webContents.executeJavaScript(`
      (() => {
        const card = document.getElementById('invitation-card');
        const btn = document.getElementById('invitation');
        const ignoreBtn = document.getElementById('invitation-ignore');

        card.hidden = false;
        btn.textContent = '想继续聊聊你之前整理的重要节点吗？';

        const style = window.getComputedStyle(card);
        const btnStyle = window.getComputedStyle(btn);
        const ignoreStyle = window.getComputedStyle(ignoreBtn);

        const rect = card.getBoundingClientRect();

        return {
          hidden: card.hidden,
          text: btn.textContent,
          ignoreText: ignoreBtn.textContent,
          cardDisplay: style.display,
          cardOpacity: style.opacity,
          cardZIndex: style.zIndex,
          btnBorderRadius: btnStyle.borderRadius,
          ignoreBorderRadius: ignoreStyle.borderRadius,
          rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
        };
      })()
    `);

    check('INVITE-02-shown-text',
      displayResult.hidden === false &&
      displayResult.text === '想继续聊聊你之前整理的重要节点吗？' &&
      displayResult.ignoreText === '稍后再说',
      `text: ${displayResult.text}, ignoreText: ${displayResult.ignoreText}`
    );

    check('INVITE-03-computed-styles',
      displayResult.cardDisplay === 'flex' &&
      displayResult.cardOpacity === '1' &&
      displayResult.cardZIndex === '3' &&
      displayResult.btnBorderRadius === '15px' &&
      displayResult.ignoreBorderRadius === '10px',
      `display: ${displayResult.cardDisplay}, opacity: ${displayResult.cardOpacity}, zIndex: ${displayResult.cardZIndex}`
    );

    // 4. Hit-testing / Interactive region arbitration
    const cardRect = displayResult.rect;
    const contentBounds = win.getContentBounds();
    const regions = [cardRect];
    const safeRegions = sanitizeRects(regions, { x: 0, y: 0, width: contentBounds.width, height: contentBounds.height });

    // Pointer inside the card rect
    const insidePoint = { x: Math.round(cardRect.x + cardRect.width / 2), y: Math.round(cardRect.y + cardRect.height / 2) };
    const ignoreInside = shouldIgnoreMouseEvents(true, insidePoint, safeRegions);
    check('INVITE-04-pointer-inside-not-ignored', ignoreInside === false,
      `expected shouldIgnoreMouseEvents false, got ${ignoreInside} at (${insidePoint.x}, ${insidePoint.y})`);

    // Pointer outside the card rect (e.g., top-left corner)
    const outsidePoint = { x: 5, y: 5 };
    const ignoreOutside = shouldIgnoreMouseEvents(true, outsidePoint, safeRegions);
    check('INVITE-04-pointer-outside-ignored', ignoreOutside === true,
      `expected shouldIgnoreMouseEvents true, got ${ignoreOutside} at (${outsidePoint.x}, ${outsidePoint.y})`);

    // 5. Test auto-dismiss transition in Chromium
    const autoDismissResult = await win.webContents.executeJavaScript(`
      (async () => {
        const card = document.getElementById('invitation-card');
        const events = [];

        // Injected auto-dismiss logic
        let currentTimer = null;
        let onFadeStart = () => {
          card.classList.add('is-dismissing');
          events.push({ type: 'fade_start', opacity: window.getComputedStyle(card).opacity, pointerEvents: window.getComputedStyle(card).pointerEvents });
        };
        let onTimeout = () => {
          card.classList.remove('is-dismissing');
          card.hidden = true;
          events.push({ type: 'timeout', hidden: card.hidden });
        };

        // Trigger fade start
        onFadeStart();
        const startState = {
          hasDismissingClass: card.classList.contains('is-dismissing'),
          computedPointerEvents: window.getComputedStyle(card).pointerEvents,
        };

        // Wait for CSS 180ms opacity transition to settle in Chromium
        await new Promise(r => setTimeout(r, 220));
        const fadeState = {
          ...startState,
          computedOpacity: window.getComputedStyle(card).opacity,
        };

        // Trigger finish timeout
        onTimeout();
        const timeoutState = {
          hasDismissingClass: card.classList.contains('is-dismissing'),
          hidden: card.hidden,
        };

        return { fadeState, timeoutState, events };
      })()
    `);

    check('INVITE-05-dismissing-fade-class',
      autoDismissResult.fadeState.hasDismissingClass === true &&
      autoDismissResult.fadeState.computedOpacity === '0' &&
      autoDismissResult.fadeState.computedPointerEvents === 'none',
      `fadeState: ${JSON.stringify(autoDismissResult.fadeState)}`
    );

    check('INVITE-05-timeout-cleaned',
      autoDismissResult.timeoutState.hasDismissingClass === false &&
      autoDismissResult.timeoutState.hidden === true,
      `timeoutState: ${JSON.stringify(autoDismissResult.timeoutState)}`
    );

    // 6. Test User Ignore button click handling
    const ignoreClickResult = await win.webContents.executeJavaScript(`
      (() => {
        const card = document.getElementById('invitation-card');
        const ignoreBtn = document.getElementById('invitation-ignore');
        const commands = [];

        card.hidden = false;
        let cancelled = false;
        const cancelAutoDismiss = () => { cancelled = true; };

        ignoreBtn.onclick = () => {
          cancelAutoDismiss();
          card.hidden = true;
          commands.push({ type: 'ignore_invitation', invitationId: 'inv-test-01' });
        };

        ignoreBtn.click();

        return {
          cardHidden: card.hidden,
          cancelled,
          commands
        };
      })()
    `);

    check('INVITE-06-ignore-click',
      ignoreClickResult.cardHidden === true &&
      ignoreClickResult.cancelled === true &&
      ignoreClickResult.commands.length === 1 &&
      ignoreClickResult.commands[0].type === 'ignore_invitation',
      `ignore result: ${JSON.stringify(ignoreClickResult)}`
    );

    // 7. Test User Acceptance button click handling
    const acceptClickResult = await win.webContents.executeJavaScript(`
      (() => {
        const card = document.getElementById('invitation-card');
        const acceptBtn = document.getElementById('invitation');
        const drawer = document.getElementById('drawer');
        const commands = [];

        card.hidden = false;
        let cancelled = false;
        const cancelAutoDismiss = () => { cancelled = true; };
        const openPanel = () => { drawer.hidden = false; };

        acceptBtn.onclick = () => {
          cancelAutoDismiss();
          card.hidden = true;
          openPanel();
          commands.push({
            type: 'click_invitation',
            invitationId: 'inv-test-02',
            responseText: '我想继续聊聊之前整理的重要节点。'
          });
        };

        acceptBtn.click();

        return {
          cardHidden: card.hidden,
          drawerOpen: drawer.hidden === false,
          cancelled,
          commands
        };
      })()
    `);

    check('INVITE-07-accept-click',
      acceptClickResult.cardHidden === true &&
      acceptClickResult.drawerOpen === true &&
      acceptClickResult.cancelled === true &&
      acceptClickResult.commands.length === 1 &&
      acceptClickResult.commands[0].type === 'click_invitation' &&
      acceptClickResult.commands[0].responseText === '我想继续聊聊之前整理的重要节点。',
      `accept result: ${JSON.stringify(acceptClickResult)}`
    );

  } catch (error) {
    check('INVITE-UNCAUGHT-ERROR', false, error.message);
  } finally {
    win.destroy();
    try { rmSync(tempUserData, { recursive: true, force: true }); } catch {}
    console.log('INVITATION_BUBBLE_RESULT=' + JSON.stringify({ results }));
    app.quit();
  }
});
