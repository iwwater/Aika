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
  await win.loadURL(targetUrl);
  await new Promise(r => setTimeout(r, 1000));

  const apiStatus = await win.webContents.executeJavaScript(`
    (async () => {
      const headers = { Authorization: 'Bearer ${currentToken}', Accept: 'application/json' };
      const resSetup = await fetch('/api/self-setup', { headers }).then(async r => ({ status: r.status, data: await r.json().catch(() => null) })).catch(e => ({ err: e.message }));
      const resSnapshot = await fetch('/api/snapshot', { headers }).then(async r => ({ status: r.status, data: await r.json().catch(() => null) })).catch(e => ({ err: e.message }));
      return { resSetup, resSnapshot };
    })()
  `);

  console.log('API Status:\n', JSON.stringify(apiStatus, null, 2));
  app.quit();
});