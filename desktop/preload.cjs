'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('shippingBridge', Object.freeze({
  getState: () => ipcRenderer.invoke('bridge:get-state'),
  pair: input => ipcRenderer.invoke('bridge:pair', input),
  openHeka: () => ipcRenderer.invoke('bridge:open-heka'),
  disconnect: () => ipcRenderer.invoke('bridge:disconnect'),
}));
