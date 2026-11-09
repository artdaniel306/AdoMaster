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
  setFlowCheck: (id, key, value, force = false) => ipcRenderer.invoke('flow:setCheck', { id, key, value, force }),
  setPlan: (id, repos, migration, note) =>
    ipcRenderer.invoke('flow:setPlan', { id, repos, migration, note }),
  setCommits: (id, stage, commits) => ipcRenderer.invoke('flow:setCommits', { id, stage, commits }),
  /** images: [{ type, data: Uint8Array }]；keep: 保留的既有圖片檔名；check: 同時勾起「測試完成」 */
  setTestRecord: (id, { note, keep, images, check }) =>
    ipcRenderer.invoke('flow:setTestRecord', { id, note, keep, images, check }),
  loadTestImages: (id) => ipcRenderer.invoke('flow:testImages', { id }),
  deployMergeStatus: (id, stage) => ipcRenderer.invoke('flow:mergeStatus', { id, stage }),
  mergeDeploy: (id, stage) => ipcRenderer.invoke('flow:mergeDeploy', { id, stage }),
  deployPipelineRuns: (id, stage) => ipcRenderer.invoke('flow:pipelineRuns', { id, stage }),
  loadRepoConfig:() => ipcRenderer.invoke('repos:config'),
  checkCommit: (repo, commit, branch) => ipcRenderer.invoke('repos:checkCommit', { repo, commit, branch }),
  branchGraph: (repo, branch, { fetch = false, all = false } = {}) =>
    ipcRenderer.invoke('repos:branchGraph', { repo, branch, fetch, all }),
  loadRepoSettings: () => ipcRenderer.invoke('repos:loadSettings'),
  saveRepoSettings: (repos) => ipcRenderer.invoke('repos:saveSettings', { repos }),
  pickRepoFolder: (defaultPath) => ipcRenderer.invoke('repos:pickFolder', defaultPath),
  openExternal: (url) => ipcRenderer.invoke('shell:open', url),
  exportLocalData: (localStorageItems) => ipcRenderer.invoke('localData:export', localStorageItems),
  pickImportZip: () => ipcRenderer.invoke('localData:pickImport'),
  applyImport: () => ipcRenderer.invoke('localData:applyImport'),
  /** 選單「檔案 → 匯出 / 匯入本地資料」被點擊時呼叫 cb('export' | 'import') */
  onLocalDataMenu: (cb) => ipcRenderer.on('menu:localData', (_e, action) => cb(action)),
  /** 選單「設定 → Repository 設定…」被點擊時呼叫 cb() */
  onRepoSettingsMenu: (cb) => ipcRenderer.on('menu:repoSettings', () => cb()),
});
