const { contextBridge, ipcRenderer } = require('electron');
const channels = new Set(['desktop', 'shell', 'diagnostic']);
// FIX61-11: `microphonePreference` carries the stored microphone device id from the shell to the renderer.
// It is a device id only — never a path, never a recording.
const methods = new Set(['receive', 'connectionChanged', 'hotkeyConfig', 'hotkeyEvent', 'displayConfig', 'managementResult', 'microphonePreference', 'rightClickRestore']);
contextBridge.exposeInMainWorld('desktopHost', {
  postMessage(name, value) { if (channels.has(name)) ipcRenderer.send('pet:' + name, value); },
  subscribe(callback) {
    if (typeof callback !== 'function') return;
    ipcRenderer.on('pet:delivery', (_event, method, ...args) => { if (methods.has(method)) callback(method, ...args); });
  }
});
