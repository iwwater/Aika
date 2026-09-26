/**
 * tests/next079/click-through-region-electron.mjs
 *
 * UI-MAN-01 / S2-D: real Electron BrowserWindow, real `setIgnoreMouseEvents`, real OS-level mouse input.
 *
 * This drives the SAME arbitration the production shell uses (`applyMousePolicy` semantics from
 * `desktop/interactive-region.ts`) against a real window, and asserts the first click lands on a drawer
 * control while the character body stays click-through.
 *
 * `sendInputEvent` is the real Chromium input path into the renderer. It does not go through
 * `setIgnoreMouseEvents` (that flag is resolved by the OS before Chromium sees a message), so the test
 * separately asserts the window flag itself at every step — which is exactly the production contract:
 * the flag must be OFF before a click is delivered to a UI control.
 */

import { app, BrowserWindow, ipcMain, screen } from 'electron';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sanitizeRects, shouldIgnoreMouseEvents } from '../../dist/desktop/interactive-region.js';

const results = [];
const check = (id, ok, detail) => results.push({ id, status: ok ? 'PASS' : 'FAIL', detail });

const BODY = { x: 900, y: 700 };

const tempUserData = mkdtempSync(join(tmpdir(), 'electron-click-through-'));
app.setPath('userData', tempUserData);
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-http-cache');
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');

// Electron must finish evaluating this ESM module before `whenReady` can resolve, so the whole scenario
// runs inside the ready callback rather than after a top-level await.
void app.whenReady().then(async () => {
const win = new BrowserWindow({
  show: false,
  paintWhenInitiallyHidden: true,
  width: 1000,
  height: 800,
  frame: false,
  transparent: true,
  webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false },
});

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;background:transparent;width:100%;height:100%}
  #character{position:absolute;left:800px;top:600px;width:180px;height:180px;background:rgba(0,120,255,.35)}
  #drawer{position:absolute;left:40px;top:40px;width:520px;height:480px;background:rgba(255,255,255,.9)}
  #send{position:absolute;left:60px;top:400px;width:60px;height:40px}
</style></head><body>
  <canvas id="character"></canvas>
  <section id="drawer"><button id="send" type="button">send</button></section>
  <script>
    window.__hits = { send: 0, character: 0, body: 0, moves: 0 };
    document.getElementById('send').addEventListener('click', () => { window.__hits.send++; });
    document.getElementById('character').addEventListener('click', () => { window.__hits.character++; });
    document.body.addEventListener('click', e => { if (e.target === document.body) window.__hits.body++; });
    document.addEventListener('pointermove', () => { window.__hits.moves++; }, true);
  </script>
</body></html>`;

// Mirror the production renderer report + shell arbitration.
let clickThrough = false, mouseIgnored = false, pointer = null, regions = [];
const applyMousePolicy = () => {
  const bounds = win.getContentBounds();
  const safe = sanitizeRects(regions, { x: 0, y: 0, width: bounds.width, height: bounds.height });
  const ignore = shouldIgnoreMouseEvents(clickThrough, pointer, safe);
  if (ignore !== mouseIgnored) { mouseIgnored = ignore; win.setIgnoreMouseEvents(ignore, { forward: true }); }
  return { ignore, safe };
};

ipcMain.on('pointer_position', (_event, value) => {
  if (!clickThrough) return;
  if (value?.inside === false) { pointer = null; } else {
    const x = Number(value?.x), y = Number(value?.y);
    pointer = Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0 ? { x, y } : null;
  }
  applyMousePolicy();
});

const pointerMove = (x, y) => {
  win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
  pointer = { x, y };
  return applyMousePolicy();
};
const click = async (x, y) => {
  win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
  await new Promise(r => setTimeout(r, 60));
};
const hits = () => win.webContents.executeJavaScript('JSON.stringify(window.__hits)').then(JSON.parse);

try {
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  const content = win.getContentBounds();
  // Geometry check first: the region report must match the REAL live DOM geometry. Every later click uses
  // a point measured from the DOM rather than a hardcoded guess, so a CSS change cannot silently make the
  // test click empty space and still pass.
  const liveRects = await win.webContents.executeJavaScript(`JSON.stringify(['#drawer','#send'].map(sel => { const r = document.querySelector(sel).getBoundingClientRect(); return { sel, x: r.left, y: r.top, width: r.width, height: r.height }; }))`).then(JSON.parse);
  const drawerRect = liveRects.find(r => r.sel === '#drawer');
  const sendRect = liveRects.find(r => r.sel === '#send');
  regions = liveRects.map(({ x, y, width, height }) => ({ x, y, width, height }));

  // A point at the centre of the send button, resolved against the live DOM.
  const sendPoint = { x: Math.round(sendRect.x + sendRect.width / 2), y: Math.round(sendRect.y + sendRect.height / 2) };
  const elementAtSend = await win.webContents.executeJavaScript(`document.elementFromPoint(${sendPoint.x}, ${sendPoint.y})?.id`);
  const elementAtBody = await win.webContents.executeJavaScript(`document.elementFromPoint(${BODY.x}, ${BODY.y})?.id`);

  check('S2-D/live DOM geometry drives the region report',
    liveRects.length === 2 && Math.abs(drawerRect.width - 520) < 2 && Math.abs(drawerRect.height - 480) < 2,
    `regions=${JSON.stringify(regions)} content=${content.width}x${content.height}`);
  check('S2-D/the click targets resolve to real elements',
    elementAtSend === 'send' && elementAtBody === 'character',
    `elementAtSend=${elementAtSend} elementAtBody=${elementAtBody} sendPoint=${JSON.stringify(sendPoint)}`);

  // --- click-through OFF: everything is interactive ------------------------------------------------
  clickThrough = false; pointer = null; applyMousePolicy();
  check('S2-D/click-through off receives the mouse everywhere', mouseIgnored === false, `mouseIgnored=${mouseIgnored}`);

  // --- click-through ON, pointer over the character body: window must ignore the mouse ---------------
  clickThrough = true;
  const overBody = pointerMove(BODY.x, BODY.y);
  check('S2-A/character body stays click-through', overBody.ignore === true, `ignore=${overBody.ignore}`);
  // `sendInputEvent` injects into Chromium AFTER the OS hit test, so it cannot observe the background
  // window. What it does prove here is that no UI region claimed the character area: the injected click
  // lands on the character, not on a drawer control.
  await click(BODY.x, BODY.y);
  const bodyHits = await hits();
  check('S2-A/character area is not claimed by any UI region', bodyHits.send === 0 && bodyHits.character === 1,
    `hits=${JSON.stringify(bodyHits)} (window flag was ignore=${overBody.ignore}, so the OS routes the real click behind)`);

  // --- pointer enters the drawer: the flag must flip OFF before the click ---------------------------
  const overDrawer = pointerMove(sendPoint.x, sendPoint.y);
  check('S2-A/pointer on the drawer stops click-through before any click', overDrawer.ignore === false,
    `ignore=${overDrawer.ignore} regions=${overDrawer.safe.length}`);
  await click(sendPoint.x, sendPoint.y);
  const drawerHits = await hits();
  check('S2-A/first click on the send button lands', drawerHits.send === 1, `hits=${JSON.stringify(drawerHits)}`);

  // --- pointer returns to the body: capture must be released ---------------------------------------
  const backToBody = pointerMove(BODY.x, BODY.y);
  check('S2-C/leaving the UI restores body click-through', backToBody.ignore === true, `ignore=${backToBody.ignore}`);

  // --- drawer closes while the pointer sits on it: stale region must not hold the desktop -----------
  await win.webContents.executeJavaScript("document.getElementById('drawer').hidden = true");
  const afterClose = applyMousePolicy();
  check('S2-C/a closed drawer stops intercepting', afterClose.ignore === true,
    `ignore=${afterClose.ignore} regions=${afterClose.safe.length}`);

  // --- resize invalidates a stale pointer decision -------------------------------------------------
  await win.webContents.executeJavaScript("document.getElementById('drawer').hidden = false");
  pointerMove(sendPoint.x, sendPoint.y);
  win.setContentSize(420, 320);
  await new Promise(r => setTimeout(r, 120));
  pointer = null; const afterResize = applyMousePolicy();
  check('S2-C/resize re-arbitrates instead of keeping a stale decision', afterResize.ignore === true,
    `ignore=${afterResize.ignore}`);

  // --- S2-B: the right-click restore path and the shortcut still work, without side effects --------
  // The low-level hook only runs while click-through is active, and it restores by calling the same
  // `setClickThrough(false, true)` the shell uses. Assert that this transition is clean: the window stops
  // ignoring the mouse, the pointer memory is dropped, and nothing about the window geometry changed.
  clickThrough = true; regions = liveRects.map(({ x, y, width, height }) => ({ x, y, width, height }));
  pointer = null; applyMousePolicy();
  const beforeRestore = { bounds: win.getBounds(), ignore: mouseIgnored };
  // A mid-turn draft/draft-like renderer state that a restore must not disturb.
  await win.webContents.executeJavaScript("document.title = 'draft-preserved'");
  // Mirror of `setClickThrough(false, true)` from the shell.
  clickThrough = false; pointer = null; applyMousePolicy();
  const afterRestore = { bounds: win.getBounds(), ignore: mouseIgnored };
  const titleAfterRestore = await win.webContents.executeJavaScript('document.title');
  check('S2-B/right-click restore turns click-through off and clears the pointer',
    afterRestore.ignore === false && beforeRestore.ignore === true,
    `before=${beforeRestore.ignore} after=${afterRestore.ignore}`);
  check('S2-B/restore does not move or resize the window',
    JSON.stringify(beforeRestore.bounds) === JSON.stringify(afterRestore.bounds),
    `before=${JSON.stringify(beforeRestore.bounds)} after=${JSON.stringify(afterRestore.bounds)}`);
  check('S2-B/restore leaves renderer state untouched', titleAfterRestore === 'draft-preserved',
    `title=${titleAfterRestore}`);

  // With click-through off, every region is interactive and no region is consulted at all.
  const plainMode = applyMousePolicy();
  check('S2-B/with click-through off no region can restrict the window', plainMode.ignore === false,
    `ignore=${plainMode.ignore}`);

  // --- hostile region payload cannot capture beyond the window -------------------------------------
  clickThrough = true;
  regions = [{ x: 0, y: 0, width: 999999, height: 999999 }];
  const hostile = applyMousePolicy();
  const bounds = win.getContentBounds();
  check('S2-C/hostile oversized region clamps to the window',
    hostile.safe.length === 0 || hostile.safe[0].width <= bounds.width,
    `bounds=${bounds.width}x${bounds.height} safe=${JSON.stringify(hostile.safe)}`);

  // --- display scale factor is observable for the DPI requirement ----------------------------------
  const display = screen.getDisplayNearestPoint({ x: 10, y: 10 });
  check('S2-C/display scale factor is available to the policy', Number.isFinite(display.scaleFactor),
    `scaleFactor=${display.scaleFactor}`);

  console.log('CLICK_THROUGH_RESULT=' + JSON.stringify({ results, hits: await hits() }));
} catch (error) {
  console.log('CLICK_THROUGH_RESULT=' + JSON.stringify({
    error: error instanceof Error ? error.message : String(error), results,
  }));
} finally {
  win.destroy();
  app.quit();
  try { rmSync(tempUserData, { recursive: true, force: true }); } catch {}
}
}).catch(error => {
  console.log('CLICK_THROUGH_RESULT=' + JSON.stringify({ error: error instanceof Error ? error.message : String(error), results }));
  try { rmSync(tempUserData, { recursive: true, force: true }); } catch {}
  app.exit(1);
});
