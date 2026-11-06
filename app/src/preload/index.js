// preload 在 sandbox 中執行，只能 require('electron')，不能 require 本地模組。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  loadIterations: () => ipcRenderer.invoke('iterations:load'),
  syncIterations: () => ipcRenderer.invoke('iterations:sync'),
  fetchWorkItems: (iterationPath, exact) => ipcRenderer.invoke('workitems:fetch', { iterationPath, exact }),
  fetchRequirementFlow: (iterationPath, exact) => ipcRenderer.invoke('flow:fetch', { iterationPath, exact }),
  loadFlowState: () => ipcRenderer.invoke('flow:loadState'),
  setFlowCheck: (id, key, value) => ipcRenderer.invoke('flow:setCheck', { id, key, value }),
  openExternal: (url) => ipcRenderer.invoke('shell:open', url),
});
