import { app, BrowserWindow } from 'electron';
import { readFile } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempUserData = mkdtempSync(join(tmpdir(), 'electron-strict-forget-'));
app.setPath('userData', tempUserData);
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-http-cache');
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');

void app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    paintWhenInitiallyHidden: true,
    width: 1280,
    height: 960,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false },
  });
  try {
    const url = process.argv[2];
    await window.loadURL(url);
    const scenario = await readFile(new URL('./strict-forget-electron-scenario.js', import.meta.url), 'utf8');
    const result = await window.webContents.executeJavaScript(`(async () => { ${scenario}\n })()`);
    console.log('STRICT_FORGET_UI_RESULT=' + JSON.stringify(result));
  } catch (error) {
    console.log('STRICT_FORGET_UI_RESULT=' + JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  } finally {
    window.destroy();
    app.quit();
    try { rmSync(tempUserData, { recursive: true, force: true }); } catch {}
  }
}).catch(error => {
  console.error(error);
  try { rmSync(tempUserData, { recursive: true, force: true }); } catch {}
  app.exit(1);
});

