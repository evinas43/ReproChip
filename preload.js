'use strict';
// Puente seguro entre la interfaz y el proceso principal. La interfaz no tiene acceso a Node.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('reprochip', {
  isElectron: true,
  serial: {
    onChoose: cb => ipcRenderer.on('serial:choose', (e, list) => cb(list)),
    onChanged: cb => ipcRenderer.on('serial:changed', (e, info) => cb(info)),
    choose: portId => ipcRenderer.send('serial:chosen', portId)
  },
  tcp: {
    connect: (host, port) => ipcRenderer.invoke('tcp:connect', { host, port }),
    write: data => ipcRenderer.invoke('tcp:write', data),
    close: () => ipcRenderer.invoke('tcp:close'),
    onData: cb => ipcRenderer.on('tcp:data', (e, d) => cb(d)),
    onClosed: cb => ipcRenderer.on('tcp:closed', (e, m) => cb(m))
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: partial => ipcRenderer.invoke('settings:set', partial)
  },
  profiles: {
    get: () => ipcRenderer.invoke('profiles:get'),
    put: data => ipcRenderer.invoke('profiles:put', data)
  },
  ai: {
    ask: payload => ipcRenderer.invoke('ai:ask', payload)
  },
  saveFile: opts => ipcRenderer.invoke('file:save', opts),
  saveBinary: opts => ipcRenderer.invoke('file:saveBinary', opts)
});
