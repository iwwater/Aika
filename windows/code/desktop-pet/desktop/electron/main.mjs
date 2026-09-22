import { app, BrowserWindow, ipcMain, protocol, screen, Menu, shell, globalShortcut } from 'electron';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BackendConnection } from './transport.mjs';
import { fitDisplay } from './layout.mjs';
import { assetResponse } from './assets.mjs';
import { managementUrl, managementTarget } from '../../tools/management-url.mjs';
import { nextUserDataDir } from '../../core/next-namespace.ts';

const here = dirname(fileURLToPath(import.meta.url));
const option = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const root = resolve(option('--root') || resolve(here, '..'));
const node = option('--node'), backend = option('--backend');
if (!node || !backend) throw Error('Use npm run dev or npm start to launch the Windows host.');
const preview = process.argv.includes('--preview');
const inspect = process.argv.includes('--inspect');
const smoke = process.argv.includes('--smoke-test');
app.setName('AAAAGENT');
app.setPath('userData', nextUserDataDir(app.getPath('appData'), smoke ? 'smoke-test' : preview ? 'preview' : 'desktop'));
if (!app.requestSingleInstanceLock({ root, preview })) { app.quit(); process.exit(0); }
protocol.registerSchemesAsPrivileged([{ scheme: 'pet', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
let win, ready = false, voiceRequested = false, wakeRequested = false, micTestRequested = false, panelOpen = false, beforeResize, clickThrough = false;
let prefs = { mode: 'full', width: 360, hotkey: null }, anchor, prefsFile, writes = Promise.resolve();
const deliver = (method, ...args) => { if (ready && win && !win.isDestroyed()) win.webContents.send('pet:delivery', method, ...args); };
const connection = new BackendConnection({
  onState: state => { voiceRequested = wakeRequested = false; deliver('connectionChanged', state); },
  onMessage: (message, generation) => {
    if (message.channel === 'wake_control') wakeRequested = message.enabled === true;
    if (message.channel === 'wake_error') wakeRequested = false;
    if (['capture_finish', 'capture_stop'].includes(message.channel)) voiceRequested = false;
    deliver('receive', message, generation);
  }
});
const validHotkey = code => code === null || /^(Arrow(Up|Down|Left|Right)|Key[A-Z]|Digit[0-9]|F([1-9]|1[0-9]|20)|Space|Enter|Backspace|Delete|Home|End|PageUp|PageDown|Comma|Period|Slash|Semicolon|Quote|BracketLeft|BracketRight|Backslash|Minus|Equal|Backquote)$/.test(code);
function savePreferences() {
  const raw = JSON.stringify({ ...prefs, anchor });
  writes = writes.then(() => writeFile(prefsFile, raw)).catch(() => process.stderr.write('Display preferences could not be saved.\n'));
}
// FIX61-11 / FIX61-07: the microphone device preference. It lives in this machine's app data beside the
// display preferences, holds a device id only (never a path or a recording), and is written on its own
// serialized chain so a preference write can never race the display write.
let microphoneFile;
const readMicrophonePreference = async () => {
  if (!microphoneFile) return null;
  try {
    const saved = JSON.parse(await readFile(microphoneFile, 'utf8'));
    return typeof saved?.deviceId === 'string' && saved.deviceId ? saved.deviceId : null;
  } catch { return null; }
};
const writeMicrophonePreference = deviceId => {
  if (!microphoneFile) return writes;
  writes = writes.then(() => writeFile(microphoneFile, JSON.stringify({ version: 1, deviceId }) + '\n', { mode: 0o600 }))
    .catch(() => process.stderr.write('Microphone preference could not be saved.\n'));
  return writes;
};
function layout() {
  if (!win || win.isDestroyed()) return;
  const display = screen.getDisplayNearestPoint({ x: Math.round(anchor.x), y: Math.round(anchor.y) });
  const fitted = fitDisplay(prefs.width, panelOpen, display.workArea, anchor, prefs.mode);
  anchor = fitted.anchor; win.setBounds(fitted.bounds); syncRightClickHookBounds(); deliver('displayConfig', fitted.config);
}
const trusted = event => win && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame && event.senderFrame.url === 'pet://app/index.html';
const start = () => connection.start(node, [backend], process.env);
const CLICK_THROUGH_SHORTCUT = 'CommandOrControl+Shift+M';
// Windows does not offer per-button hit testing through setIgnoreMouseEvents: forward=true only
// forwards mouse movement. The low-level helper observes right-button presses while click-through is
// active and restores this window only when the press lands inside its bounds; the window-message hook
// remains a same-process fallback for hosts that still deliver the native message.
const RIGHT_CLICK_MESSAGES = [0x0204, 0x0205, 0x00a4, 0x00a5, 0x007b];
let rightClickHooked = false, rightClickProcess = null, rightClickBuffer = '';
function stopRightClickHook() {
  if (!rightClickProcess) return;
  rightClickProcess.kill(); rightClickProcess = null; rightClickBuffer = '';
}
function syncRightClickHookBounds() {
  if (!rightClickProcess || !win || win.isDestroyed()) return;
  const dip = win.getBounds();
  const bounds = screen.dipToScreenRect ? screen.dipToScreenRect(win, dip) : dip;
  try { rightClickProcess.stdin.write(`${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}\n`); } catch {}
}
function startRightClickHook() {
  if (process.platform !== 'win32' || rightClickProcess || !win || win.isDestroyed()) return;
  const hookFile = resolve(root, 'desktop/electron/right-click-hook.ps1');
  rightClickProcess = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', hookFile], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  rightClickProcess.stdin.on('error', () => {});
  syncRightClickHookBounds();
  rightClickProcess.stdout.setEncoding('utf8');
  rightClickProcess.stdout.on('data', chunk => {
    rightClickBuffer += chunk;
    const lines = rightClickBuffer.split(/\r?\n/); rightClickBuffer = lines.pop() || '';
    for (const line of lines) {
      const match = /^R (-?\d+) (-?\d+)$/.exec(line.trim());
      if (!match || !clickThrough || !win || win.isDestroyed()) continue;
      const rawX = Number(match[1]), rawY = Number(match[2]);
      const point = screen.screenToDipPoint ? screen.screenToDipPoint({ x: rawX, y: rawY }) : { x: rawX, y: rawY };
      const x = point.x, y = point.y, bounds = win.getBounds();
      if (x < bounds.x || y < bounds.y || x >= bounds.x + bounds.width || y >= bounds.y + bounds.height) continue;
      setClickThrough(false, true);
      deliver('rightClickRestore', { x: x - bounds.x, y: y - bounds.y });
    }
  });
  rightClickProcess.once('error', () => { rightClickProcess = null; rightClickBuffer = ''; });
  rightClickProcess.once('exit', () => { rightClickProcess = null; rightClickBuffer = ''; });
}
function setClickThrough(enabled, focusOnRestore = false) {
  clickThrough = enabled === true;
  if (!win || win.isDestroyed()) return;
  win.setIgnoreMouseEvents(clickThrough, { forward: true });
  if (clickThrough) startRightClickHook(); else stopRightClickHook();
  if (!clickThrough && focusOnRestore) { win.show(); win.focus(); }
  deliver('clickThroughChanged', { enabled: clickThrough });
}

ipcMain.on('pet:desktop', (event, value) => {
  if (!trusted(event) || !value || value.generation !== connection.generation || connection.state !== 'ready' || !value.message || typeof value.message !== 'object') return;
  const type = value.message.command?.type;
  if (['start_voice', 'click_invitation'].includes(type)) voiceRequested = true;
  if (['finish_voice', 'cancel', 'submit_text'].includes(type)) voiceRequested = false;
  connection.send(value.message, value.generation);
});
ipcMain.on('pet:shell', async (event, value) => {
  if (!trusted(event) || !value || typeof value !== 'object') return;
  switch (value.type) {
    case 'ready':
      if (ready) return;
      ready = true; layout(); deliver('hotkeyConfig', { code: prefs.hotkey });
      // FIX61-10 (FIX61-07 07-C "重启一致"): report the stored microphone choice on every fresh page so
      // the conversation capture applies the same device after a restart, not only in the test panel.
      void readMicrophonePreference().then(deviceId => deliver('microphonePreference', deviceId));
      start(); break;
    case 'panel': panelOpen = value.open === true; layout(); if (panelOpen) win.focus(); break;
    case 'focus': win.focus(); break;
    case 'drag':
      if (Number.isFinite(value.dx) && Number.isFinite(value.dy) && Math.abs(value.dx) < 2000 && Math.abs(value.dy) < 2000) {
        anchor.x += value.dx; anchor.y += value.dy; layout(); savePreferences();
      } break;
    case 'set_click_through':
      setClickThrough(value.enabled); break;
    case 'set_display': if (['full', 'half'].includes(value.mode)) { prefs.mode = value.mode; layout(); savePreferences(); } break;
    case 'resize_model':
      if (value.phase === 'begin') beforeResize ??= prefs.width;
      else if (beforeResize !== undefined) {
        if (value.phase === 'cancel') { prefs.width = beforeResize; beforeResize = undefined; }
        else if (['update', 'commit'].includes(value.phase) && Number.isFinite(value.width)) {
          prefs.width = Math.max(220, Math.min(720, value.width));
          if (value.phase === 'commit') { beforeResize = undefined; savePreferences(); }
        }
        layout();
      } break;
    case 'set_hotkey': if (validHotkey(value.code)) { prefs.hotkey = value.code; savePreferences(); deliver('hotkeyConfig', { code: prefs.hotkey }); } break;
    case 'reconnect': if (['failed', 'disconnected'].includes(connection.state)) start(); break;
    // FIX61-11 / FIX61-07: an explicit, user-initiated microphone-test lease. It grants AUDIO ONLY, and
    // only while the test panel is open, so a mic test never needs the backend to be ready and can never
    // open the camera. Releasing the lease drops the permission again immediately.
    case 'mic_test_request':
      micTestRequested = true;
      // FIX61-11: the renderer owns the device but not the file. The chosen device id is stored here, in
      // this machine's app data, and reported back — the renderer never sees a path.
      deliver('microphonePreference', await readMicrophonePreference());
      break;
    case 'mic_test_release': micTestRequested = false; break;
    case 'mic_test_preference':
      // null is an explicit "use the system default device", distinct from a missing value.
      if (value.deviceId !== null && (typeof value.deviceId !== 'string' || !value.deviceId.trim() || value.deviceId.length > 512)) break;
      await writeMicrophonePreference(value.deviceId);
      break;
    // FIX61-03: a visible startup can be cancelled; EOF first, then the shutdown timeout.
    case 'cancel_startup': if (connection.state === 'connecting') void connection.cancel(); break;
    case 'disconnect': if (value.generation === connection.generation) connection.close(); break;
    case 'open_management':
      if (preview) { deliver('managementResult', { ok: false }); break; }
      // FIX61-04: a panel entry may name a console section. Only a same-origin console path is accepted;
      // an absolute URL from the renderer is refused rather than handed to the shell.
      if (value.path !== undefined && (typeof value.path !== 'string' || !/^\/(?!\/)[A-Za-z0-9._~\-/?#=&%]*$/.test(value.path))) { deliver('managementResult', { ok: false }); break; }
      void managementUrl(process.env.PET_TRIAL_CONFIG)
        // FIX61-11: the route is MERGED into the session fragment. Composing with `new URL(value.path, url)`
        // replaced the whole fragment and silently dropped `#token=`, so 外观 / 换肤 opened in the locked
        // state even though the page itself was right.
        .then(url => shell.openExternal(managementTarget(url, value.path)))
        .then(() => deliver('managementResult', { ok: true })).catch(() => deliver('managementResult', { ok: false })); break;
    case 'quit': app.quit(); break;
  }
});
ipcMain.on('pet:diagnostic', (event, value) => {
  if (!trusted(event) || !value) return;
  // Don't copy arbitrary renderer text, chat or media into diagnostic logs.
  if (['model-ready', 'model-error', 'script-error', 'promise-error'].includes(value.type)) process.stderr.write(`Renderer: ${value.type}: ${value.message || ""}\n`);
});

// Do not await readiness at module scope: Electron must finish loading this ESM
// entry before it can emit ready. Keep initialization in the ready callback.
void app.whenReady().then(async () => {
await mkdir(app.getPath('userData'), { recursive: true });
prefsFile = resolve(app.getPath('userData'), 'windows-display.json');
microphoneFile = resolve(app.getPath('userData'), 'microphone.json');
try {
  const saved = JSON.parse(await readFile(prefsFile, 'utf8'));
  if (['full', 'half'].includes(saved.mode)) prefs.mode = saved.mode;
  if (Number.isFinite(saved.width)) prefs.width = Math.max(220, Math.min(720, saved.width));
  if (validHotkey(saved.hotkey)) prefs.hotkey = saved.hotkey;
  if (Number.isFinite(saved.anchor?.x) && Number.isFinite(saved.anchor?.y)) anchor = saved.anchor;
} catch {}
const area = screen.getPrimaryDisplay().workArea;
anchor ??= { x: area.x + area.width - 220, y: area.y + Math.max(0, area.height - 430) };
win = new BrowserWindow({ title: preview ? 'AAAAGENT · Offline preview' : 'AAAAGENT', width: 380, height: 376,
  frame: false, transparent: true, backgroundColor: '#00000000', alwaysOnTop: true, hasShadow: false, resizable: false, show: !smoke,
  webPreferences: { preload: resolve(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true,
    partition: 'aaaagent-desktop', backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' } });
Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'AAAAGENT', submenu: [
  { label: 'Reload', accelerator: 'Ctrl+R', click: () => { connection.close(); ready = false; win.webContents.reload(); } },
  { label: 'Developer tools', accelerator: 'Ctrl+Shift+I', click: () => win.webContents.toggleDevTools() },
  { label: 'Toggle click-through', click: () => setClickThrough(!clickThrough, true) },
  { role: 'quit' }
] }, { role: 'editMenu' }]));
if (!globalShortcut.register(CLICK_THROUGH_SHORTCUT, () => setClickThrough(!clickThrough, true)))
  process.stderr.write('Click-through shortcut could not be registered.\n');
await win.webContents.session.protocol.handle('pet', request => assetResponse(root, request.url));
// FIX61-11 / FIX61-07: a microphone test is a separate, explicit lease (`mic_test_request`). It grants
// AUDIO only — `video` still requires a real voice turn, so a mic test can never light the camera — and
// it is deliberately independent of `voiceRequested`, so a failed or not-yet-ready backend does not stop
// the user from checking whether the device itself works.
const mediaAllowed = (wc, permission, origin, types, mainFrame) => !preview && wc === win.webContents && permission === 'media'
  && origin?.startsWith('pet://app/') && mainFrame !== false && types.length > 0
  && types.every(type => type === 'audio' ? voiceRequested || wakeRequested || micTestRequested : type === 'video' && voiceRequested);
win.webContents.session.setPermissionRequestHandler((wc, permission, callback, details) => callback(mediaAllowed(wc, permission, details.requestingUrl, details.mediaTypes || [], details.isMainFrame)));
win.webContents.session.setPermissionCheckHandler((wc, permission, origin, details) => mediaAllowed(wc, permission, origin + '/', [details.mediaType], details.isMainFrame));
win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
win.webContents.on('will-navigate', event => event.preventDefault());
win.webContents.on('will-attach-webview', event => event.preventDefault());
win.webContents.on('render-process-gone', () => { ready = false; connection.close(); });
win.on('blur', () => { if (beforeResize !== undefined) { prefs.width = beforeResize; beforeResize = undefined; layout(); } deliver('hotkeyEvent', { type: 'cancel' }); });
for (const message of RIGHT_CLICK_MESSAGES) {
  win.hookWindowMessage(message, () => {
    if (clickThrough) setClickThrough(false, true);
  });
}
rightClickHooked = true;
screen.on('display-metrics-changed', layout); screen.on('display-removed', layout);
app.on('second-instance', () => { win.show(); win.focus(); });
let quitDrained = false, quitPending = false;
app.on('before-quit', event => {
  if (quitDrained) return;
  event.preventDefault();
  if (quitPending) return;
  quitPending = true;
  // Keep pipes and the Electron event loop alive until backend EOF cleanup
  // finishes. Otherwise Windows can leave backend.lock after the window closes.
  void connection.close().then(() => writes).finally(() => { quitDrained = true; app.quit(); });
});
app.on('will-quit', () => {
  globalShortcut.unregister(CLICK_THROUGH_SHORTCUT);
  stopRightClickHook();
  if (rightClickHooked && win && !win.isDestroyed()) for (const message of RIGHT_CLICK_MESSAGES) win.unhookWindowMessage(message);
  rightClickHooked = false;
});
app.on('window-all-closed', () => app.quit());
layout();
await win.loadURL('pet://app/index.html');
if (inspect) win.webContents.openDevTools({ mode: 'detach' });
if (smoke) {
  try {
    // Exercise the real Electron renderer in an offscreen window; no account or device access.
    const deadline = Date.now() + 20000;
    let loaded = false;
    while (Date.now() < deadline) {
      loaded = await win.webContents.executeJavaScript("!!window.petBridge && document.getElementById('loading').hidden && !document.getElementById('send').disabled");
      if (loaded) break;
      await new Promise(done => setTimeout(done, 200));
    }
    if (!loaded) throw Error('Renderer or offline backend did not become ready: ' + await win.webContents.executeJavaScript("document.getElementById('status').textContent"));
    await win.webContents.executeJavaScript("document.getElementById('open').click();document.getElementById('text').value='Windows bridge smoke test';document.getElementById('form').requestSubmit();");
    await new Promise(done => setTimeout(done, 400));
    const echoed = await win.webContents.executeJavaScript("document.getElementById('reply').textContent.includes('Offline preview received')");
    if (!echoed) throw Error('Text did not complete a backend round trip');
    await win.webContents.executeJavaScript("window.desktopHost.postMessage('shell',{type:'set_click_through',enabled:true})");
    await new Promise(done => setTimeout(done, 300));
    await win.webContents.executeJavaScript("window.desktopHost.postMessage('shell',{type:'set_click_through',enabled:false})");
    console.log('WINDOWS_SMOKE_OK: Live2D renderer, isolated preload, backend round trip, panel layout.');
    if (option('--screenshot')) {
      win.showInactive();
      await new Promise(done => setTimeout(done, 600));
      const visible = await win.webContents.executeJavaScript("!document.getElementById('drawer').hidden && getComputedStyle(document.getElementById('drawer')).opacity === '1'");
      if (!visible) throw Error('Chat drawer is not visible');
      await writeFile(resolve(option('--screenshot')), (await win.webContents.capturePage()).toPNG());
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  app.quit();
}
}).catch(error => { console.error(error.message); app.exit(1); });
