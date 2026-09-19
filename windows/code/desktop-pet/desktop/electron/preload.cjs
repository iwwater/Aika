const { contextBridge, ipcRenderer } = require('electron');
const channels = new Set(['desktop', 'shell', 'diagnostic']);
const methods = new Set(['receive', 'connectionChanged', 'hotkeyConfig', 'hotkeyEvent', 'displayConfig', 'managementResult']);
contextBridge.exposeInMainWorld('desktopHost', {
  postMessage(name, value) { if (channels.has(name)) ipcRenderer.send('pet:' + name, value); },
  subscribe(callback) {
    if (typeof callback !== 'function') return;
    ipcRenderer.on('pet:delivery', (_event, method, ...args) => { if (methods.has(method)) callback(method, ...args); });
  }
});
