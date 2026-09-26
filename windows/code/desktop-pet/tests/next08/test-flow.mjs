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

  const testFlow = await win.webContents.executeJavaScript(`
    (async () => {
      const steps = [];
      // 1. Open dialogue config
      const configureBtn = document.querySelector('#configure-dialogue');
      if (configureBtn) configureBtn.click();
      await new Promise(r => setTimeout(r, 600));
      steps.push('Opened dialogue config');

      // 2. Click "✨ 一键切换/新建为自定义配置 (OpenAI 兼容)"
      const newCustomBtn = document.querySelector('#new-custom-dialogue');
      if (newCustomBtn) newCustomBtn.click();
      await new Promise(r => setTimeout(r, 600));
      steps.push('Clicked new custom config');

      // 3. Click preset model button "deepseek-chat"
      const modelBtns = Array.from(document.querySelectorAll('.model-presets button'));
      const chatBtn = modelBtns.find(b => b.textContent.trim() === 'deepseek-chat');
      if (chatBtn) chatBtn.click();
      await new Promise(r => setTimeout(r, 600));
      steps.push('Selected model preset: ' + (chatBtn ? 'deepseek-chat' : 'not found'));

      // 4. Click preset endpoint button "DeepSeek 官方"
      const epBtns = Array.from(document.querySelectorAll('.endpoint-presets button'));
      const deepseekEpBtn = epBtns.find(b => b.textContent.trim() === 'DeepSeek 官方');
      if (deepseekEpBtn) deepseekEpBtn.click();
      await new Promise(r => setTimeout(r, 600));
      steps.push('Selected endpoint preset: ' + (deepseekEpBtn ? 'DeepSeek 官方' : 'not found'));

      // 5. Inspect input values
      const modelVal = document.querySelector('#model-dialogue')?.value;
      const epVal = document.querySelector('#endpoint-dialogue')?.value;
      steps.push('Current model: ' + modelVal);
      steps.push('Current endpoint: ' + epVal);

      // 6. Check save button
      const saveBtn = document.querySelector('#settings-save');
      const canSave = saveBtn && !saveBtn.disabled;
      steps.push('Save button enabled: ' + canSave);

      if (canSave) {
        saveBtn.click();
        steps.push('Clicked save button');
        await new Promise(r => setTimeout(r, 2000));
      }

      // 7. Check notices or errors
      const errorNotice = document.querySelector('.notice.error')?.textContent || null;
      const warningNotice = document.querySelector('.notice.warning')?.textContent || null;
      steps.push('Error notice: ' + errorNotice);
      steps.push('Warning notice: ' + warningNotice);

      return { steps };
    })()
  `);

  console.log('Test flow execution:\n', JSON.stringify(testFlow.steps, null, 2));

  // Check file on disk
  const userSettingsFile = resolve(root, '../../.local/model-evaluation/trial/user-trial/management-settings.json');
  const savedContent = JSON.parse(readFileSync(userSettingsFile, 'utf8'));
  console.log('\nDisk verification:');
  console.log('Revision:', savedContent.current.revision);
  console.log('Dialogue adapterId:', savedContent.current.settings.providers.dialogue.adapterId);
  console.log('Dialogue model:', savedContent.current.settings.providers.dialogue.model);
  console.log('Dialogue endpoint:', savedContent.current.settings.providers.dialogue.endpoint);
  console.log('Dialogue credentialRef:', savedContent.current.settings.providers.dialogue.credentialRef);

  app.quit();
});