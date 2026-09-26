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

  const result = await win.webContents.executeJavaScript(`
    (async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const waitFor = async (sel, timeout = 8000) => {
        const start = Date.now();
        while (Date.now() - start < timeout) {
          const el = document.querySelector(sel);
          if (el) return el;
          await wait(150);
        }
        return null;
      };

      const results = {};

      // 1. First ensure dialogue button is ready
      const dialogueBtn = await waitFor('#configure-dialogue');
      if (!dialogueBtn) return { error: 'Initial render timed out' };

      // 2. Open details for background slots
      const backgroundDetails = Array.from(document.querySelectorAll('details')).find(d => d.textContent.includes('后台模块'));
      if (backgroundDetails) backgroundDetails.open = true;
      await wait(300);

      const slots = ['dialogue', 'admission', 'memory_turn', 'summary'];

      for (const slot of slots) {
        const btn = document.querySelector('#configure-' + slot);
        if (!btn) {
          results[slot] = 'btn not found';
          continue;
        }
        btn.click();
        await wait(500);

        const epInput = document.querySelector('#endpoint-' + slot);
        const modelInput = document.querySelector('#model-' + slot);
        const newCustomBtn = document.querySelector('#new-custom-' + slot);

        results[slot] = {
          hasNewCustomBtn: !!newCustomBtn,
          epTag: epInput?.tagName,
          epVal: epInput?.value,
          modelTag: modelInput?.tagName,
          modelVal: modelInput?.value,
        };
      }

      return results;
    })()
  `);

  console.log('Slots inspection result:\n', JSON.stringify(result, null, 2));
  app.quit();
});