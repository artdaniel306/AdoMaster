// preload 在 sandbox 中執行，只能 require('electron')，不能 require 本地模組。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  loadIterations: () => ipcRenderer.invoke('iterations:load'),
  syncIterations: () => ipcRenderer.invoke('iterations:sync'),
  fetchWorkItems: (iterationPath, exact) => ipcRenderer.invoke('workitems:fetch', { iterationPath, exact }),
  fetchRequirementFlow: (iterationPath, exact) => ipcRenderer.invoke('flow:fetch', { iterationPath, exact }),
  createDefaultTask: (id, description) => ipcRenderer.invoke('flow:createTask', { id, description }),
  updateRequirementState: (id, state) => ipcRenderer.invoke('flow:updateState', { id, state }),
  loadFlowState: () => ipcRenderer.invoke('flow:loadState'),
  setFlowCheck: (id, key, value) => ipcRenderer.invoke('flow:setCheck', { id, key, value }),
  setUnderstand: (id, repos, migration, note) =>
    ipcRenderer.invoke('flow:setUnderstand', { id, repos, migration, note }),
  setCommits: (id, stage, commits) => ipcRenderer.invoke('flow:setCommits', { id, stage, commits }),
  deployMergeStatus: (id, stage) => ipcRenderer.invoke('flow:mergeStatus', { id, stage }),
  mergeDeploy: (id, stage) => ipcRenderer.invoke('flow:mergeDeploy', { id, stage }),
  loadRepoConfig:() => ipcRenderer.invoke('repos:config'),
  checkCommit: (repo, commit, branch) => ipcRenderer.invoke('repos:checkCommit', { repo, commit, branch }),
  openExternal: (url) => ipcRenderer.invoke('shell:open', url),
});
