import { app, BrowserWindow } from 'electron';

// The two console pages are read-only presentation over HTTP routes; hardware acceleration is irrelevant
// here and is disabled so the run is deterministic on a headless CI machine.
app.disableHardwareAcceleration();
void app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false, paintWhenInitiallyHidden: true, width: 1280, height: 1000,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false },
  });
  try {
    await window.loadURL(process.argv[2]);
    let result;
    for (let attempt = 0; attempt < 300; attempt++) {
      result = await window.webContents.executeJavaScript("document.querySelector('#console-result[data-complete=true]')?.textContent");
      if (result) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!result) {
      const diagnostic = await window.webContents.executeJavaScript("JSON.stringify({ nav: document.querySelector('nav.nav')?.textContent ?? null, html: document.body.innerHTML.slice(0, 600) })");
      console.log('CONSOLE_UI_DEBUG=' + diagnostic);
    }
    console.log('CONSOLE_UI_RESULT=' + (result || JSON.stringify({ error: 'UI timeout' })));
  } finally {
    window.destroy();
    app.quit();
  }
}).catch(error => { console.error(error); app.exit(1); });
