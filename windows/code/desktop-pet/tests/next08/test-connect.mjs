import { app, BrowserWindow } from 'electron';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sessionJson = resolve(root, '.local/acceptance-mgmt/management-session.json');
const session = JSON.parse(readFileSync(sessionJson, 'utf8'));
const currentToken = session.url.split('#token=')[1];
const targetUrl = `http://127.0.0.1:10158/#token=${currentToken}`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1280, height: 900, show: false });
  console.log('Loading with token:', targetUrl);
  await win.loadURL(targetUrl);
  await new Promise(r => setTimeout(r, 2000));

  const result = await win.webContents.executeJavaScript(`
    (async () => {
      // Navigate to models page
      const navModels = document.querySelector('#nav-models');
      if (navModels) navModels.click();
      await new Promise(r => setTimeout(r, 1000));

      const configureBtn = document.querySelector('#configure-dialogue');
      if (configureBtn) configureBtn.click();
      await new Promise(r => setTimeout(r, 500));

      const ep = document.querySelector('#endpoint-dialogue');
      const model = document.querySelector('#model-dialogue');
      const newCustomBtn = document.querySelector('#new-custom-dialogue');

      return {
        hasConfigureBtn: !!configureBtn,
        hasNewCustomBtn: !!newCustomBtn,
        epVal: ep?.value,
        epTag: ep?.tagName,
        modelVal: model?.value,
        modelTag: model?.tagName,
      };
    })()
  `);

  console.log('Navigation & Inspection result:\n', JSON.stringify(result, null, 2));
  app.quit();
});