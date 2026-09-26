import { app, BrowserWindow } from 'electron';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempUserData = mkdtempSync(join(tmpdir(), 'electron-fix61-03-'));
app.setPath('userData', tempUserData);
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-http-cache');
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
// Electron must finish loading this ESM module before readiness can resolve.
void app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false, paintWhenInitiallyHidden: true, width: 1200, height: 1000,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false },
  });
  try {
    await window.loadURL(process.argv[2]);
    let result;
    for (let attempt = 0; attempt < 300; attempt++) {
      result = await window.webContents.executeJavaScript("document.querySelector('#startup-result[data-complete=true]')?.textContent");
      if (result) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!result) {
      const diagnostic = await window.webContents.executeJavaScript("JSON.stringify({ status: document.getElementById('status')?.textContent, html: document.body.innerHTML.slice(0, 600) })");
      console.log('STARTUP_UI_DEBUG=' + diagnostic);
    }
    console.log('STARTUP_UI_RESULT=' + (result || JSON.stringify({ error: 'UI timeout' })));
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
