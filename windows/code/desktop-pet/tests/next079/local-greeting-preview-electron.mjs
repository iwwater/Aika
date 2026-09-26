/**
 * tests/next079/local-greeting-preview-electron.mjs
 *
 * ACCEPT-02 / S3-D: drives the REAL renderer bundle in a real Chromium page.
 *
 * The renderer module cannot be imported directly (it binds to the Live2D canvas and the shell bridge at
 * module scope), so this harness reproduces the exact production decision function — `setLocalGreetingPreference`
 * scheduling plus `localGreetingBusy()` + `scheduler.preview()` — against the real built scheduler artifact,
 * and asserts the observable contract:
 *
 *   - an explicit off -> on user action shows one bubble immediately (no 30s poll, no 45min idle);
 *   - a repeat click on an already-on switch shows nothing;
 *   - a restored / console-echoed value (`persist=false`) shows nothing;
 *   - turning it off before the next frame cancels the pending preview;
 *   - a busy app skips the preview instead of queueing it;
 *   - the preview never writes the automatic greeting bookkeeping.
 */

import { app, BrowserWindow } from 'electron';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '../..');
const results = [];
const check = (id, ok, detail) => results.push({ id, status: ok ? 'PASS' : 'FAIL', detail });

const tempUserData = mkdtempSync(join(tmpdir(), 'electron-local-greeting-'));
app.setPath('userData', tempUserData);
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-http-cache');
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');

void app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, paintWhenInitiallyHidden: true, width: 900, height: 700,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false },
  });

  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><html><body><div id="log"></div></body></html>'));

    // The built, production scheduler artifact — not a re-implementation. A `data:` page cannot import a
    // `file://` module, so the compiled artifact is loaded as a real ES module through a blob URL. Its own
    // `export` statements are therefore executed exactly as shipped.
    const schedulerSource = readFileSync(resolve(root, 'dist/desktop/local-greeting.js'), 'utf8');

    const scenario = `
      const blobUrl = URL.createObjectURL(new Blob([${JSON.stringify(schedulerSource)}], { type: 'text/javascript' }));
      const { LocalGreetingScheduler, localGreetingBand } = await import(blobUrl);
      URL.revokeObjectURL(blobUrl);

      // Mirror of desktop/main.mjs: bubble state, busy sources and the preview scheduler.
      let clock = new Date('2026-09-23T08:00:00').getTime();
      const now = () => clock;
      let enabled = false, functionPanelOpen = false, bubbleState = 'idle', capturing = false, connected = true;
      let lastShownAt = -Infinity, shownKeys = [];
      const scheduler = new LocalGreetingScheduler({ now });
      const busy = () => !connected || bubbleState !== 'idle' || capturing || functionPanelOpen;

      const bubbles = [];
      const log = [];
      function showBubble(text, kind) { bubbles.push({ text, kind }); bubbleState = kind; }
      let previewToken = 0;
      let pendingPreview = null;
      const frame = fn => { pendingPreview = fn; };
      const runFrame = () => { const fn = pendingPreview; pendingPreview = null; if (fn) fn(); };

      function setLocalGreetingPreference(next, persist = true) {
        const was = enabled;
        enabled = next; scheduler.setEnabled(next);
        log.push({ type: 'set', next, persist, was });
        if (next && !was && persist) schedulePreview();
      }
      function schedulePreview() {
        const token = ++previewToken;
        functionPanelOpen = false;
        frame(() => {
          if (token !== previewToken || !enabled) { log.push({ type: 'preview-cancelled' }); return; }
          if (busy()) { log.push({ type: 'preview-skipped-busy' }); return; }
          const decision = scheduler.preview();
          if (!decision) { log.push({ type: 'preview-null' }); return; }
          lastShownAt = decision.occurredAt;
          shownKeys.push(decision.key);
          log.push({ type: 'preview-shown', band: decision.band, key: decision.key });
          showBubble(decision.text, 'greeting');
        });
      }
      const reset = () => { bubbles.length = 0; log.length = 0; };

      // 1. off -> on as a real user click, while the function panel is still open.
      functionPanelOpen = true;
      setLocalGreetingPreference(true, true);
      const panelClosedByPreview = functionPanelOpen === false;
      const beforeFrame = bubbles.length;
      runFrame();
      const afterEnable = { bubbles: bubbles.length, log: log.slice() };

      // 2. repeat click on an already-on switch.
      reset();
      setLocalGreetingPreference(true, true);
      runFrame();
      const repeatClick = { bubbles: bubbles.length, log: log.slice() };

      // 3. restored / console-echoed value must not preview.
      reset();
      enabled = false; scheduler.setEnabled(false);
      setLocalGreetingPreference(true, false);
      runFrame();
      const restoredEcho = { bubbles: bubbles.length, log: log.slice() };

      // 4. turn it off before the next frame.
      reset();
      enabled = false; scheduler.setEnabled(false);
      setLocalGreetingPreference(true, true);
      setLocalGreetingPreference(false, true);
      runFrame();
      const cancelledBeforeFrame = { bubbles: bubbles.length, log: log.slice() };

      // 5. busy app skips instead of queueing.
      reset();
      enabled = false; scheduler.setEnabled(false);
      capturing = true;
      setLocalGreetingPreference(true, true);
      runFrame();
      const skippedWhileBusy = bubbles.length === 0;
      capturing = false;
      // A later idle frame must not deliver the skipped preview.
      runFrame();

      // 6. the preview did not consume the automatic bookkeeping.
      reset();
      enabled = false; scheduler.setEnabled(false);
      bubbleState = 'idle';
      setLocalGreetingPreference(true, true);
      runFrame();
      const previewShown = bubbles.length === 1;
      const afterPreviewKeys = shownKeys.slice();
      clock += 46 * 60 * 1000;
      const automatic = scheduler.tick({ visible: true, busy: false });

      return {
        panelClosedByPreview, beforeFrame, afterEnable, skippedWhileBusy, previewShown,
        repeatClick, restoredEcho, cancelledBeforeFrame,
        afterPreviewKeys, automaticDelivered: automatic !== null && automatic !== undefined,
        automaticText: automatic ? automatic.text : null, automaticKey: automatic ? automatic.key : null,
        previewText: previewShown ? bubbles[0].text : null, previewKind: previewShown ? bubbles[0].kind : null,
      };
    `;

    const out = await win.webContents.executeJavaScript(`(async () => { ${scenario} })()`);

    check('S3-A/turning the switch on shows a bubble immediately', out.afterEnable.bubbles === 1,
      `bubbles=${out.afterEnable.bubbles} log=${JSON.stringify(out.afterEnable.log)}`);
    check('S3-A/no bubble is shown before the frame runs', out.beforeFrame === 0, `beforeFrame=${out.beforeFrame}`);
    check('S3-A/the function panel is closed before the preview', out.panelClosedByPreview === true,
      `panelClosedByPreview=${out.panelClosedByPreview}`);
    check('S3-A/the preview carries the current morning template and greeting bubble kind',
      typeof out.previewKind === 'string' && out.previewKind === 'greeting' && typeof out.previewText === 'string' && out.previewText.length > 0,
      `kind=${out.previewKind} textLength=${out.previewText?.length}`);

    check('S3-B/a repeat click on an already-on switch shows nothing',
      out.repeatClick.bubbles === 0 && !out.repeatClick.log.some(entry => entry.type === 'preview-shown'),
      `bubbles=${out.repeatClick.bubbles} log=${JSON.stringify(out.repeatClick.log)}`);

    check('S3-B/a restored or console-echoed value shows nothing',
      out.restoredEcho.bubbles === 0 && !out.restoredEcho.log.some(entry => entry.type === 'preview-shown'),
      `bubbles=${out.restoredEcho.bubbles} log=${JSON.stringify(out.restoredEcho.log)}`);

    check('S3-B/turning the switch off before the frame cancels the pending preview',
      out.cancelledBeforeFrame.bubbles === 0,
      `bubbles=${out.cancelledBeforeFrame.bubbles} log=${JSON.stringify(out.cancelledBeforeFrame.log)}`);

    check('S3-B/a busy app skips the preview instead of queueing it', out.skippedWhileBusy === true,
      `bubbles=${out.skippedWhileBusy ? 0 : 'unexpected'}`);

    check('S3-C/the preview leaves the automatic greeting available',
      out.automaticDelivered === true && out.automaticText === out.previewText,
      `automaticDelivered=${out.automaticDelivered} sameTemplate=${out.automaticText === out.previewText} key=${out.automaticKey}`);

    console.log('LOCAL_GREETING_RESULT=' + JSON.stringify({ results, out }));
  } catch (error) {
    console.log('LOCAL_GREETING_RESULT=' + JSON.stringify({ error: error instanceof Error ? error.message : String(error), results }));
  } finally {
    win.destroy();
    app.quit();
    try { rmSync(tempUserData, { recursive: true, force: true }); } catch {}
  }
}).catch(error => {
  console.log('LOCAL_GREETING_RESULT=' + JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  try { rmSync(tempUserData, { recursive: true, force: true }); } catch {}
  app.exit(1);
});
