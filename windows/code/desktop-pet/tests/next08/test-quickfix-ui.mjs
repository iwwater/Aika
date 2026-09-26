import { app, BrowserWindow } from 'electron';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sessionJson = resolve(root, '.local/acceptance-mgmt/management-session.json');
const session = JSON.parse(readFileSync(sessionJson, 'utf8'));
const targetUrl = `http://127.0.0.1:10158/#page=models&token=${session.url.split('#token=')[1]}`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    }
  });

  const errors = [];
  win.webContents.on('console-message', (event, level, message, line, sourceId) => {
    if (level >= 2 || message.includes('Error') || message.includes('Uncaught')) {
      errors.push({ level, message, line, sourceId });
    }
  });

  console.log('Loading target URL:', targetUrl);
  await win.loadURL(targetUrl);
  await new Promise(r => setTimeout(r, 2000));

  const result = await win.webContents.executeJavaScript(`
    (async () => {
      const logs = [];
      // 1. Check if configure-dialogue exists
      const btn = document.querySelector('#configure-dialogue');
      logs.push('configure-dialogue btn exists: ' + !!btn);
      if (btn) btn.click();
      await new Promise(r => setTimeout(r, 1000));

      // 2. Check if new-custom-dialogue button exists
      const newCustomBtn = document.querySelector('#new-custom-dialogue');
      logs.push('new-custom-dialogue exists: ' + !!newCustomBtn);

      // 3. Check endpoint and model inputs
      const endpointInput = document.querySelector('#endpoint-dialogue');
      const modelInput = document.querySelector('#model-dialogue');
      logs.push('endpoint input tag: ' + (endpointInput ? endpointInput.tagName : 'null'));
      logs.push('endpoint input val: ' + (endpointInput ? endpointInput.value : 'null'));
      logs.push('model input tag: ' + (modelInput ? modelInput.tagName : 'null'));
      logs.push('model input val: ' + (modelInput ? modelInput.value : 'null'));

      // 4. Click new-custom button
      if (newCustomBtn) {
        newCustomBtn.click();
        await new Promise(r => setTimeout(r, 1000));
        logs.push('Clicked newCustomBtn');
      }

      const endpointAfter = document.querySelector('#endpoint-dialogue');
      const modelAfter = document.querySelector('#model-dialogue');
      logs.push('endpoint after newCustom: ' + (endpointAfter ? endpointAfter.value : 'null'));
      logs.push('model after newCustom: ' + (modelAfter ? modelAfter.value : 'null'));

      // 5. Test typing custom values
      if (endpointAfter && modelAfter) {
        endpointAfter.value = 'https://api.deepseek.com/chat/completions';
        endpointAfter.dispatchEvent(new Event('input', { bubbles: true }));
        modelAfter.value = 'deepseek-chat';
        modelAfter.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(r => setTimeout(r, 500));
      }

      // 6. Check preset buttons
      const presetBtns = Array.from(document.querySelectorAll('.endpoint-presets button')).map(b => b.textContent.trim());
      logs.push('endpoint presets: ' + presetBtns.join(', '));

      // 7. Check save button
      const saveBtn = document.querySelector('#settings-save');
      logs.push('saveBtn exists: ' + !!saveBtn);
      logs.push('saveBtn disabled: ' + (saveBtn ? saveBtn.disabled : 'null'));
      logs.push('saveBtn text: ' + (saveBtn ? saveBtn.textContent.trim() : 'null'));

      // 8. Test clicking save
      if (saveBtn && !saveBtn.disabled) {
        saveBtn.click();
        await new Promise(r => setTimeout(r, 1500));
        const saveAfter = document.querySelector('#settings-save');
        logs.push('saveBtn disabled after save: ' + (saveAfter ? saveAfter.disabled : 'null'));
      }

      return { logs };
    })()
  `);

  console.log('Result logs:', JSON.stringify(result.logs, null, 2));
  console.log('Console errors:', JSON.stringify(errors, null, 2));
  app.quit();
});