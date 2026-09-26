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
  win.webContents.on('console-message', (e, level, msg) => console.log('[Browser Console]', msg));
  await win.loadURL(targetUrl);
  await new Promise(r => setTimeout(r, 3000));

  const pageState = await win.webContents.executeJavaScript(`
    ({
      href: window.location.href,
      h1: Array.from(document.querySelectorAll('h1, h2')).map(h => h.textContent.trim()),
      buttons: Array.from(document.querySelectorAll('button')).map(b => b.textContent.trim()).slice(0, 15)
    })
  `);
  console.log('PageState:', JSON.stringify(pageState, null, 2));
  app.quit();
});