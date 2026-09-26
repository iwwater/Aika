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

  const domInfo = await win.webContents.executeJavaScript(`
    (() => {
      const configureBtn = document.querySelector('#configure-dialogue');
      if (configureBtn) configureBtn.click();
      return {
        inputs: Array.from(document.querySelectorAll('input, select, textarea, button')).map(el => ({
          tag: el.tagName,
          id: el.id,
          name: el.name,
          text: el.textContent.trim().slice(0, 30)
        }))
      };
    })()
  `);

  console.log('DOM Elements:', JSON.stringify(domInfo.inputs, null, 2));
  app.quit();
});