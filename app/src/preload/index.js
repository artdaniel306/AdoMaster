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
  /** target = 'saas' | 'local'（各自寫入不同的資料庫） */
  upagentReleaseStatus: (id, stage, target) => ipcRenderer.invoke('upagentRelease:status', { id, stage, target }),
  /** 執行 UpAgent 發佈（shell/Release-UpAgent.ps1），完成後回傳該 Requirement 更新後的狀態 */
  runUpagentRelease: (id, stage, target, { bump, remark, rerunAction } = {}) =>
    ipcRenderer.invoke('upagentRelease:run', { id, stage, target, bump, remark, rerunAction: !!rerunAction }),
  cancelUpagentRelease: () => ipcRenderer.invoke('upagentRelease:cancel'),
  /** UpAgent 發佈的即時輸出：cb({ id, stage, line })；步驟開始：cb({ id, stage, step }) */
  onUpagentReleaseLog: (cb) => ipcRenderer.on('upagentRelease:log', (_e, data) => cb(data)),
  onUpagentReleaseStep: (cb) => ipcRenderer.on('upagentRelease:step', (_e, data) => cb(data)),
  loadRepoConfig:() => ipcRenderer.invoke('repos:config'),
  checkCommit: (repo, commit, branch) => ipcRenderer.invoke('repos:checkCommit', { repo, commit, branch }),
  branchGraph: (repo, branch, { fetch = false, all = false } = {}) =>
    ipcRenderer.invoke('repos:branchGraph', { repo, branch, fetch, all }),
  loadRepoSettings: () => ipcRenderer.invoke('repos:loadSettings'),
  saveRepoSettings: (repos) => ipcRenderer.invoke('repos:saveSettings', { repos }),
  pickRepoFolder: (defaultPath) => ipcRenderer.invoke('repos:pickFolder', defaultPath),
  /** 範例：執行 shell/example.ps1，回傳其 JSON 結果 */
  runPowerShellExample: (name) => ipcRenderer.invoke('powershell:example', { name }),
  openExternal: (url) => ipcRenderer.invoke('shell:open', url),
  exportLocalData: (localStorageItems) => ipcRenderer.invoke('localData:export', localStorageItems),
  pickImportZip: () => ipcRenderer.invoke('localData:pickImport'),
  applyImport: () => ipcRenderer.invoke('localData:applyImport'),
  /** 選單「檔案 → 匯出 / 匯入本地資料」被點擊時呼叫 cb('export' | 'import') */
  onLocalDataMenu: (cb) => ipcRenderer.on('menu:localData', (_e, action) => cb(action)),
  /** 選單「設定 → Repository 設定…」被點擊時呼叫 cb() */
  onRepoSettingsMenu: (cb) => ipcRenderer.on('menu:repoSettings', () => cb()),
});
