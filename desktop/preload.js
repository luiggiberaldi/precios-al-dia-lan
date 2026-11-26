const { contextBridge, ipcRenderer } = require('electron');

// Exponer APIs seguras al contexto del navegador (frontend de React)
contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  platform: process.platform,
  lan: {
    getConfig: () => ipcRenderer.invoke('lan:getConfig'),
    setMasterMode: (opts) => ipcRenderer.invoke('lan:setMasterMode', opts),
    setClientMode: (opts) => ipcRenderer.invoke('lan:setClientMode', opts),
    resetRole: () => ipcRenderer.invoke('lan:resetRole'),
    discoverServers: () => ipcRenderer.invoke('lan:discoverServers'),
    getServerStatus: () => ipcRenderer.invoke('lan:getServerStatus'),
    exportBackupNow: () => ipcRenderer.invoke('lan:exportBackupNow'),
    repairFirewall: () => ipcRenderer.invoke('lan:repairFirewall'),
  },
  updater: {
    getState: () => ipcRenderer.invoke('app:getUpdateState'),
    checkNow: () => ipcRenderer.invoke('app:checkForUpdates'),
    installNow: () => ipcRenderer.invoke('app:installUpdateNow'),
    onStateChange: (cb) => {
      if (typeof cb !== 'function') return () => {};
      const listener = (_event, state) => cb(state);
      ipcRenderer.on('app:updateState', listener);
      return () => ipcRenderer.removeListener('app:updateState', listener);
    },
  },
});

window.addEventListener('DOMContentLoaded', () => {
  console.info('Precios al Día LAN: Entorno de escritorio inicializado.');
});
