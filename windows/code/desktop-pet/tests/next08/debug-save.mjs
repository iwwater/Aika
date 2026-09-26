import { app, BrowserWindow } from 'electron';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sessionJson = resolve(root, '.local/acceptance-mgmt/management-session.json');
const session = JSON.parse(readFileSync(sessionJson, 'utf8'));
const targetUrl = `http://127.0.0.1:10158/#page=models&token=${session.url.split('#token=')[1]}`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1280, height: 900, show: false });
  await win.loadURL(targetUrl);
  await new Promise(r => setTimeout(r, 2000));

  const debug = await win.webContents.executeJavaScript(`
    (async () => {
      // Access app state via window if possible, or trigger save and intercept
      const btn = document.querySelector('#configure-dialogue');
      if (btn) btn.click();
      await new Promise(r => setTimeout(r, 500));

      const newCustomBtn = document.querySelector('#new-custom-dialogue');
      if (newCustomBtn) newCustomBtn.click();
      await new Promise(r => setTimeout(r, 500));

      const model = document.querySelector('#model-dialogue');
      const endpoint = document.querySelector('#endpoint-dialogue');

      model.value = 'deepseek-chat';
      model.dispatchEvent(new Event('input', { bubbles: true }));

      endpoint.value = 'https://api.deepseek.com/chat/completions';
      endpoint.dispatchEvent(new Event('input', { bubbles: true }));

      await new Promise(r => setTimeout(r, 500));

      const saveBtn = document.querySelector('#settings-save');
      let fetchResult = null;
      let fetchErr = null;

      try {
        saveBtn.click();
        await new Promise(r => setTimeout(r, 2000));
      } catch (e) {
        fetchErr = e.message;
      }

      return {
        saveBtnText: saveBtn ? saveBtn.textContent : null,
        saveBtnDisabled: saveBtn ? saveBtn.disabled : null,
        errorNotice: document.querySelector('.notice.error')?.textContent || null,
        warningNotice: document.querySelector('.notice.warning')?.textContent || null,
        successNotice: document.querySelector('.notice.success')?.textContent || null,
      };
    })()
  `);

  console.log('Debug result:', JSON.stringify(debug, null, 2));
  app.quit();
});