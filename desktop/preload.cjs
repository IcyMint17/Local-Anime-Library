/**
 * The only bridge between the page and the desktop shell.
 *
 * contextIsolation stays on and nodeIntegration stays off, so the renderer gets
 * exactly these calls and no access to Node or Electron beyond them. CommonJS
 * on purpose: Electron loads preload scripts as CommonJS unless they are .mjs.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopWindow', {
  minimize: () => ipcRenderer.send('window:minimize'),
  toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
  close: () => ipcRenderer.send('window:close'),
  openMenu: () => ipcRenderer.send('window:menu'),
  getState: () => ipcRenderer.invoke('window:get-state'),
  cacheInfo: () => ipcRenderer.invoke('cache:info'),
  gpuInfo: () => ipcRenderer.invoke('gpu:info'),
  clearCache: () => ipcRenderer.invoke('cache:clear'),
  onStateChange: (listener) => {
    const handler = (_event, state) => listener(state);
    ipcRenderer.on('window:state', handler);
    return () => ipcRenderer.removeListener('window:state', handler);
  },
});
