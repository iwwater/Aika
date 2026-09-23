import { app, BrowserWindow } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

const tempUserData = mkdtempSync(join(tmpdir(), 'electron-console-audit-'));
app.setPath('userData', tempUserData);
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-http-cache');
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');

void app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    paintWhenInitiallyHidden: true,
    width: 1440,
    height: 960,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  try {
    const targetUrl = process.argv[2];
    await window.loadURL(targetUrl);

    const scenario = await readFile(new URL('./console-audit-scenario.js', import.meta.url), 'utf8');
    const result = await window.webContents.executeJavaScript(`(async () => { ${scenario}\n })()`);

    // Capture visual screenshot evidence for key pages using authentic DOM tab clicks
    const evidenceDir = resolve(import.meta.dirname, '../../../../../docs/next/0.79/evidence/acceptance-20260923');
    const screenshotPages = [
      { id: 'overview', module: '运行', label: '总览' },
      { id: 'health', module: '运行', label: '模块状态' },
      { id: 'events', module: '运行', label: 'Trace' },
      { id: 'memory', module: '角色', label: '记忆' },
      { id: 'models', module: '配置', label: 'API 与模型' },
      { id: 'knowledge', module: '扩展', label: '知识库' }
    ];
    result.screenshots = [];
    for (const item of screenshotPages) {
      await window.webContents.executeJavaScript(`(() => {
        const mod = [...document.querySelectorAll('.nav-module-btn')].find(b => b.textContent.includes(${JSON.stringify(item.module)}));
        if (mod) mod.click();
      })()`);
      await new Promise(r => setTimeout(r, 100));
      await window.webContents.executeJavaScript(`(() => {
        const tab = [...document.querySelectorAll('.sub-nav-tab')].find(b => b.textContent.includes(${JSON.stringify(item.label)}));
        if (tab) tab.click();
      })()`);
      await new Promise(r => setTimeout(r, 250));
      const img = await window.webContents.capturePage();
      const filename = `20-console-audit-${item.id}.png`;
      await writeFile(resolve(evidenceDir, filename), img.toPNG());
      result.screenshots.push(filename);
    }

    console.log('CONSOLE_AUDIT_UI_RESULT=' + JSON.stringify(result));
  } catch (error) {
    console.log('CONSOLE_AUDIT_UI_RESULT=' + JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  } finally {
    window.destroy();
    app.quit();
    try { rmSync(tempUserData, { recursive: true, force: true }); } catch {}
  }
}).catch(error => {
  console.error(error);
  try { rmSync(tempUserData, { recursive: true, force: true }); } catch {}
  app.exit(1);
});
