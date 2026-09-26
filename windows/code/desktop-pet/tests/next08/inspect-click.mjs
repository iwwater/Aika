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

  const domDump = await win.webContents.executeJavaScript(`
    (async () => {
      document.querySelector('#configure-dialogue')?.click();
      await new Promise(r => setTimeout(r, 600));
      const beforeClick = {
        modelVal: document.querySelector('#model-dialogue')?.value,
        endpointVal: document.querySelector('#endpoint-dialogue')?.value,
      };

      const newBtn = document.querySelector('#new-custom-dialogue');
      if (newBtn) newBtn.click();
      await new Promise(r => setTimeout(r, 600));

      const afterClick = {
        hasModelDialogue: !!document.querySelector('#model-dialogue'),
        modelVal: document.querySelector('#model-dialogue')?.value,
        hasEndpointDialogue: !!document.querySelector('#endpoint-dialogue'),
        endpointVal: document.querySelector('#endpoint-dialogue')?.value,
        providerSlot: window.location.hash,
        htmlSnippet: document.querySelector('#provider-dialogue')?.innerHTML?.slice(0, 300) || 'NOT FOUND',
        bodySnippet: document.body.innerText.slice(0, 300)
      };

      return { beforeClick, afterClick };
    })()
  `);

  console.log('DOM Dump:', JSON.stringify(domDump, null, 2));
  app.quit();
});