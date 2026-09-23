import { app, BrowserWindow } from 'electron';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

const tempUserData = mkdtempSync(join(tmpdir(), 'electron-memory-audit-'));
app.setPath('userData', tempUserData);
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-http-cache');
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');

void app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    paintWhenInitiallyHidden: true,
    width: 1280,
    height: 960,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  const sessionFile = resolve('../../.local/model-evaluation/trial/user-trial/management-session.json');
  if (!existsSync(sessionFile)) {
    console.error('Session file not found');
    app.exit(1);
    return;
  }
  const session = JSON.parse(readFileSync(sessionFile, 'utf8'));
  const targetUrl = session.url + '&page=memory&section=records';

  try {
    await win.loadURL(targetUrl);
    const result = await win.webContents.executeJavaScript(`(async () => {
      const pause = ms => new Promise(res => setTimeout(res, ms));
      const waitFor = async (pred, msg, timeout = 10000) => {
        const start = Date.now();
        while (Date.now() - start < timeout) {
          const v = pred();
          if (v) return v;
          await pause(50);
        }
        throw new Error(msg);
      };

      await waitFor(() => document.querySelector('.record-row'), 'Records did not load');
      const firstRow = document.querySelector('.record-row');
      firstRow.click();

      await waitFor(() => document.querySelector('#record-save'), 'Record editor did not open');
      const saveBtn = document.querySelector('#record-save');
      const forgetBtn = document.querySelector('#record-forget');

      const initialHasForget = !!forgetBtn && forgetBtn.textContent.includes('遗忘/删除此记忆');

      // Click forget button to trigger confirmation box
      if (forgetBtn) forgetBtn.click();
      await waitFor(() => document.querySelector('#record-confirm-forget'), 'Confirmation dialog did not appear');

      const confirmBtn = document.querySelector('#record-confirm-forget');
      const cancelBtn = document.querySelector('#record-cancel-forget');

      // Cancel so we do not mutate real data during audit
      if (cancelBtn) cancelBtn.click();
      await waitFor(() => !document.querySelector('#record-confirm-forget'), 'Confirmation dialog did not close on cancel');

      return {
        recordsLoaded: true,
        saveBtnPresent: !!saveBtn,
        forgetBtnPresent: initialHasForget,
        confirmationDialogWorks: !!confirmBtn && !!cancelBtn,
        cancelRestoredState: true,
      };
    })()`);

    console.log('MEMORY_FORGET_AUDIT=' + JSON.stringify(result, null, 2));
  } catch (err) {
    console.error('Memory audit error:', err);
    process.exitCode = 1;
  } finally {
    win.destroy();
    app.quit();
    try { rmSync(tempUserData, { recursive: true, force: true }); } catch {}
  }
});
