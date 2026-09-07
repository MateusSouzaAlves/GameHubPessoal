const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  if (typeof callback !== 'function') return () => {};
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('api', Object.freeze({
  library: Object.freeze({
    scan: () => ipcRenderer.invoke('library:scan'),
    getAll: () => ipcRenderer.invoke('library:getAll'),
    getRecentlyAdded: limit => ipcRenderer.invoke('library:getRecentlyAdded', limit),
    getRecentlyPlayed: limit => ipcRenderer.invoke('library:getRecentlyPlayed', limit),
    onUpdated: callback => subscribe('library:updated', callback)
  }),
  game: Object.freeze({
    launch: gameId => ipcRenderer.invoke('game:launch', gameId),
    getStatus: gameId => ipcRenderer.invoke('game:getStatus', gameId),
    openFolder: (gameId, kind) => ipcRenderer.invoke('game:openFolder', gameId, kind),
    onStatusChanged: callback => subscribe('game:statusChanged', callback)
  }),
  config: Object.freeze({
    get: () => ipcRenderer.invoke('config:get'),
    update: settings => ipcRenderer.invoke('config:update', settings),
    addScanPath: () => ipcRenderer.invoke('config:addScanPath'),
    removeScanPath: scanPath => ipcRenderer.invoke('config:removeScanPath', scanPath)
  }),
  saves: Object.freeze({
    discover: gameId => ipcRenderer.invoke('saves:discover', gameId),
    addLocation: gameId => ipcRenderer.invoke('saves:addLocation', gameId),
    backupGame: gameId => ipcRenderer.invoke('saves:backupGame', gameId),
    backupAll: () => ipcRenderer.invoke('saves:backupAll'),
    getBackups: gameId => ipcRenderer.invoke('saves:getBackups', gameId),
    restoreBackup: (gameId, backupId) => ipcRenderer.invoke('saves:restoreBackup', gameId, backupId),
    openBackupFolder: () => ipcRenderer.invoke('saves:openBackupFolder'),
    onBackupCreated: callback => subscribe('backup:created', callback)
  }),
  analytics: Object.freeze({
    getSummary: () => ipcRenderer.invoke('analytics:getSummary')
  }),
  cloud: Object.freeze({
    getStatus: () => ipcRenderer.invoke('cloud:getStatus'),
    importCredentials: () => ipcRenderer.invoke('cloud:importCredentials'),
    connect: () => ipcRenderer.invoke('cloud:connect'),
    syncNow: () => ipcRenderer.invoke('cloud:syncNow'),
    disconnect: () => ipcRenderer.invoke('cloud:disconnect'),
    forget: () => ipcRenderer.invoke('cloud:forget'),
    onStatusChanged: callback => subscribe('cloud:statusChanged', callback)
  }),
  xoutput: Object.freeze({
    launch: () => ipcRenderer.invoke('xoutput:launch'),
    status: () => ipcRenderer.invoke('xoutput:status'),
    openFolder: () => ipcRenderer.invoke('xoutput:openFolder'),
    onStatusChanged: callback => subscribe('xoutput:statusChanged', callback)
  }),
  window: Object.freeze({
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximize: () => ipcRenderer.invoke('window:maximize'),
    close: () => ipcRenderer.invoke('window:close')
  })
}));
