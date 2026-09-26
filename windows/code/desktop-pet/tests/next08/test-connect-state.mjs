import { app, BrowserWindow } from 'electron';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sessionJson = resolve(root, '.local/acceptance-mgmt/management-session.json');
const session = JSON.parse(readFileSync(sessionJson, 'utf8'));
const currentToken = session.url.split('#token=')[1];
const targetUrl = `http://127.0.0.1:10158/#page=models&token=${currentToken}`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1280, height: 900, show: false });
  win.webContents.on('console-message', (e, level, msg) => console.log('[Browser]', msg));
  await win.loadURL(targetUrl);
  await new Promise(r => setTimeout(r, 2000));

  const page = await win.webContents.executeJavaScript(`
    ({
      body: document.body.innerText.slice(0, 400),
      buttons: Array.from(document.querySelectorAll('button')).map(b => ({ id: b.id, text: b.textContent.trim() }))
    })
  `);

  console.log('Page state:', JSON.stringify(page, null, 2));
  app.quit();
});