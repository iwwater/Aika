import { app, BrowserWindow } from 'electron';

app.disableHardwareAcceleration();
// Electron must finish loading this ESM module before readiness can resolve.
void app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false, paintWhenInitiallyHidden: true, width: 1200, height: 1000,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false },
  });
  try {
    await window.loadURL(process.argv[2]);
    let result;
    for (let attempt = 0; attempt < 300; attempt++) {
      result = await window.webContents.executeJavaScript("document.querySelector('#result[data-complete=true]')?.textContent");
      if (result) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!result || result.includes('"error"')) {
      const diagnostic = await window.webContents.executeJavaScript("JSON.stringify({ html: document.body.innerHTML.slice(0, 600), scripts: [...document.scripts].map(s => s.src), title: document.title })");
      console.log('AIKA_UI_DEBUG=' + diagnostic);
    }
    console.log('AIKA_UI_RESULT=' + (result || JSON.stringify({ error: 'UI timeout' })));
  } finally {
    window.destroy();
    app.quit();
  }
}).catch(error => { console.error(error); app.exit(1); });
