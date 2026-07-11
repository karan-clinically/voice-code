// Minimal, safe IPC surface. The renderer does all API/WS calls itself over
// localhost; this only exposes Electron-specific capabilities.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cvh', {
  appInfo: () => ipcRenderer.invoke('app:info'),
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  clipboardImagePath: () => ipcRenderer.invoke('clipboard:imageToTemp'),
  onHarnessLog: (cb) => {
    const h = (_e, text) => cb(text);
    ipcRenderer.on('harness:log', h);
    return () => ipcRenderer.removeListener('harness:log', h);
  },
  onHarnessStatus: (cb) => {
    const h = (_e, status) => cb(status);
    ipcRenderer.on('harness:status', h);
    return () => ipcRenderer.removeListener('harness:status', h);
  },
});
