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

  const result = await win.webContents.executeJavaScript(`
    (async () => {
      // 1. Open dialogue config
      const btn = document.querySelector('#configure-dialogue');
      if (btn) btn.click();
      await new Promise(r => setTimeout(r, 500));

      // 2. Click new custom config button
      const newCustomBtn = document.querySelector('#new-custom-dialogue');
      if (newCustomBtn) newCustomBtn.click();
      await new Promise(r => setTimeout(r, 500));

      // 3. Type custom model & endpoint
      const endpoint = document.querySelector('#endpoint-dialogue');
      const model = document.querySelector('#model-dialogue');
      endpoint.value = 'https://api.deepseek.com/chat/completions';
      endpoint.dispatchEvent(new Event('input', { bubbles: true }));

      model.value = 'deepseek-chat';
      model.dispatchEvent(new Event('input', { bubbles: true }));

      await new Promise(r => setTimeout(r, 500));

      // 4. Click save
      const saveBtn = document.querySelector('#settings-save');
      if (!saveBtn || saveBtn.disabled) return { success: false, reason: 'save button disabled' };

      saveBtn.click();
      await new Promise(r => setTimeout(r, 2000));

      // 5. Check notice or version strip
      const strip = document.querySelector('.version-strip')?.textContent || '';
      return { success: true, strip, modelVal: model.value, endpointVal: endpoint.value };
    })()
  `);

  console.log('Save result:', JSON.stringify(result, null, 2));

  // Check saved file on disk
  const userSettingsFile = resolve(root, '../../.local/model-evaluation/trial/user-trial/management-settings.json');
  const savedContent = JSON.parse(readFileSync(userSettingsFile, 'utf8'));
  console.log('Disk revision:', savedContent.current.revision);
  console.log('Saved dialogue model:', savedContent.current.settings.providers.dialogue.model);
  console.log('Saved dialogue endpoint:', savedContent.current.settings.providers.dialogue.endpoint);
  console.log('Saved dialogue adapterId:', savedContent.current.settings.providers.dialogue.adapterId);

  app.quit();
});