import { app, BrowserWindow } from 'electron';

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false });
  const targetUrl = 'http://127.0.0.1:10158/#page=models&token=9e8255c744ed55706b6bdebc91271b9d9445a30454511b35417ed975d51f8e4d';
  await win.loadURL(targetUrl);
  await new Promise(r => setTimeout(r, 2500));

  const info = await win.webContents.executeJavaScript(`
    ({
      url: window.location.href,
      title: document.title,
      bodyText: document.body.innerText.slice(0, 500),
      buttons: Array.from(document.querySelectorAll('button')).map(b => ({ id: b.id, text: b.textContent.trim() }))
    })
  `);
  console.log('Page info:', JSON.stringify(info, null, 2));
  app.quit();
});