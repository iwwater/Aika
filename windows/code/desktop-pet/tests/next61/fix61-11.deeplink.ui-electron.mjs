import { app, BrowserWindow } from 'electron';

// One real console window per hash, loaded in a REAL browser window with the production webPreferences.
//
// Electron itself receives a single base64 argument: Chromium mis-parses a second URL-shaped command-line
// argument on Windows (the process dies before `ready`), and a quoted JSON argument loses its quotes in the
// shell. The URL list therefore travels inside one quote-free token.
app.disableHardwareAcceleration();
app.on('window-all-closed', () => { /* the next hash opens its own window; never quit between loads */ });

const decode = value => JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));

async function load(url) {
  const window = new BrowserWindow({
    show: false, paintWhenInitiallyHidden: true, width: 1280, height: 1000,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false },
  });
  try {
    await window.loadURL(url);
    let result;
    for (let attempt = 0; attempt < 300; attempt++) {
      result = await window.webContents.executeJavaScript("document.querySelector('#console-result[data-complete=true]')?.textContent");
      if (result) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!result) {
      const diagnostic = await window.webContents.executeJavaScript("JSON.stringify({ hash: location.hash, h1: document.querySelector('h1')?.textContent ?? null, nav: document.querySelector('nav.nav')?.textContent ?? null, html: document.body.innerHTML.slice(0, 400) })");
      return { url, error: 'UI timeout', diagnostic };
    }
    return { url, ...JSON.parse(result) };
  } finally {
    window.destroy();
  }
}

void app.whenReady().then(async () => {
  const { origin, hashes } = decode(process.argv[2]);
  const results = [];
  try {
    for (const hash of hashes) results.push(await load(origin + hash));
    console.log('CONSOLE_DEEPLINK_RESULT=' + JSON.stringify(results));
  } finally {
    app.quit();
  }
}).catch(error => { console.error(error); app.exit(1); });
