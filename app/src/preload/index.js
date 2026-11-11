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
  /**
   * Pipeline Run 成功後的佈版後動作（測試環境：重啟 App Service；正式環境：After-ProdDeploy.ps1，
   * restart = { date, slot } 時在 Azure Automation 排程重啟，null = 不排程）
   */
  afterDeploy: (id, stage, repo, commit, restart = null) => ipcRenderer.invoke('flow:afterDeploy', { id, stage, repo, commit, restart }),
  /** target = 'saas' | 'local'（各自寫入不同的資料庫） */
  upagentReleaseStatus: (id, stage, target) => ipcRenderer.invoke('upagentRelease:status', { id, stage, target }),
  /** 執行 UpAgent 發佈（shell/Release-UpAgent.ps1），完成後回傳該 Requirement 更新後的狀態 */
  runUpagentRelease: (id, stage, target, { bump, remark, rerunAction } = {}) =>
    ipcRenderer.invoke('upagentRelease:run', { id, stage, target, bump, remark, rerunAction: !!rerunAction }),
  cancelUpagentRelease: () => ipcRenderer.invoke('upagentRelease:cancel'),
  /** UpAgent 發佈的即時輸出：cb({ id, stage, line })；步驟開始：cb({ id, stage, step }) */
  onUpagentReleaseLog: (cb) => ipcRenderer.on('upagentRelease:log', (_e, data) => cb(data)),
  onUpagentReleaseStep: (cb) => ipcRenderer.on('upagentRelease:step', (_e, data) => cb(data)),
  /** 勾 Local 前查詢要做 Local 佈版（shell/Deploy-Local.ps1）的 repository */
  localDeployStatus: (id, stage) => ipcRenderer.invoke('localDeploy:status', { id, stage }),
  /** 依序對 repos 執行 Local 佈版，完成後回傳該 Requirement 更新後的狀態；rebuild = 忽略已 build 的 image tar */
  runLocalDeploy: (id, stage, repos, { rebuild = false } = {}) => ipcRenderer.invoke('localDeploy:run', { id, stage, repos, rebuild: !!rebuild }),
  cancelLocalDeploy: () => ipcRenderer.invoke('localDeploy:cancel'),
  /** Local 佈版的即時輸出：cb({ id, stage, line })；步驟：cb({ id, stage, repo, step }) */
  onLocalDeployLog: (cb) => ipcRenderer.on('localDeploy:log', (_e, data) => cb(data)),
  onLocalDeployStep: (cb) => ipcRenderer.on('localDeploy:step', (_e, data) => cb(data)),
  /**
   * 手動佈版：params = { repo, env: 'test' | 'prod', target: 'saas' | 'local', commit, rebuild,
   *   release?: { mode: 'new', bump, branch, remark } | { mode: 'resume', version, startFrom, remark } }（release 只有 upagent）
   */
  manualDeployPreview: (params) => ipcRenderer.invoke('manualDeploy:preview', params),
  manualDeployStart: (params) => ipcRenderer.invoke('manualDeploy:start', params),
  manualDeployCancel: (id) => ipcRenderer.invoke('manualDeploy:cancel', { id }),
  manualDeployRetry: (id, { rerunAction = false } = {}) => ipcRenderer.invoke('manualDeploy:retry', { id, rerunAction: !!rerunAction }),
  manualDeployDismiss: (id) => ipcRenderer.invoke('manualDeploy:dismiss', { id }),
  manualDeployList: () => ipcRenderer.invoke('manualDeploy:list'),
  manualDeployShowOutput: (id) => ipcRenderer.invoke('manualDeploy:showOutput', { id }),
  manualDeployCustomers: () => ipcRenderer.invoke('manualDeploy:customers'),
  manualDeployProdHead: (repo) => ipcRenderer.invoke('manualDeploy:prodHead', { repo }),
  /** 手動佈版工作的快照：cb(job)（job.removed = 已從清單移除）；輸出：cb({ id, line }) */
  onManualDeployUpdate: (cb) => ipcRenderer.on('manualDeploy:update', (_e, data) => cb(data)),
  onManualDeployLog: (cb) => ipcRenderer.on('manualDeploy:log', (_e, data) => cb(data)),
  /** 正式環境排程重啟：config.json prodRestart 的摘要 { configured, error, automationAccount, runbook, repos: [{ key, appService }] } */
  prodRestartOptions: () => ipcRenderer.invoke('prodRestart:options'),
  /** Automation 中已排程的重啟（含已過期）：{ automationAccount, runbook, items } */
  listRestartSchedules: () => ipcRenderer.invoke('prodRestart:list'),
  /** 建立重啟排程：repos 為 repo key 陣列，slot 為 RESTART_SLOTS 的 key；回傳 { items: [{ repo, ok, state, message }] } */
  createRestartSchedules: (repos, date, slot, note) => ipcRenderer.invoke('prodRestart:create', { repos, date, slot, note }),
  deleteRestartSchedule: (name) => ipcRenderer.invoke('prodRestart:delete', { name }),
  /** 「正式環境排程重啟設定」dialog：config.json 的 prodRestart */
  loadProdRestartSettings: () => ipcRenderer.invoke('prodRestart:loadSettings'),
  /** settings { subscription, resourceGroup, … }；parameters [{ name, value }]；repos [{ key, appService, resourceGroup }] */
  saveProdRestartSettings: (settings, parameters, repos) => ipcRenderer.invoke('prodRestart:saveSettings', { settings, parameters, repos }),
  /** 選單「佈版 → 手動佈版… / 佈版進度… / 正式環境排程重啟…」被點擊時呼叫 cb('manual' | 'progress' | 'restart') */
  onDeployMenu: (cb) => ipcRenderer.on('menu:deploy', (_e, action) => cb(action)),
  /** UpAgent 連線：要刪除的設定檔與各目標是否有 Activation Code */
  upagentConnectionStatus: () => ipcRenderer.invoke('upagentConnection:status'),
  /** 切換 UpAgent 連線（刪掉 UpAgent 設定檔），回傳 { target, label, activationCode, files } */
  switchUpagentConnection: (target) => ipcRenderer.invoke('upagentConnection:switch', { target }),
  /** 「UpAgent 連線設定」dialog：config.json 的 upagentConnection */
  loadUpagentConnectionSettings: () => ipcRenderer.invoke('upagentConnection:loadSettings'),
  /** configFile: string[]，codes: { local_test: '...', ... }（空白 = 刪除） */
  saveUpagentConnectionSettings: (configFile, codes) => ipcRenderer.invoke('upagentConnection:saveSettings', { configFile, codes }),
  /** 選擇 UpAgent 設定檔（可多選）；回傳路徑陣列（使用者資料夾換回 %APPDATA% 等），取消 = null */
  pickUpagentConfigFile: (current) => ipcRenderer.invoke('upagentConnection:pickFile', current),
  /** 「UpAgent 發佈資料庫設定」dialog：config.json upagentRelease.db + .env 的 UPAGENT_DB_*_PASSWORD */
  loadUpagentReleaseDbSettings: () => ipcRenderer.invoke('upagentReleaseDb:loadSettings'),
  /** dbs: { test_saas: { psql, host, port, dbname, user, sslmode, password }, ... }（空白 = 刪除該欄位 / 改用預設） */
  saveUpagentReleaseDbSettings: (dbs) => ipcRenderer.invoke('upagentReleaseDb:saveSettings', { dbs }),
  /** 選擇 psql 執行檔；取消 = null */
  pickPsql: (current) => ipcRenderer.invoke('upagentReleaseDb:pickPsql', current),
  /**
   * 雲端同步所有 repository（shell/Sync-Repos.ps1）；fetchOnly = 只 fetch 不快轉。
   * 回傳 { repos: [{ key, kind: 'dev' | 'deploy', path, status, message, upToDate, branches: [{ branch, upstream, status, detail }] }] }
   */
  runRepoSync: (fetchOnly = false) => ipcRenderer.invoke('repoSync:run', { fetchOnly: !!fetchOnly }),
  cancelRepoSync: () => ipcRenderer.invoke('repoSync:cancel'),
  /** 同步的即時輸出：cb({ line }) */
  onRepoSyncLog: (cb) => ipcRenderer.on('repoSync:log', (_e, data) => cb(data)),
  /** 選單「工具 → 同步所有 Repository…」被點擊時呼叫 cb() */
  onRepoSyncMenu: (cb) => ipcRenderer.on('menu:repoSync', () => cb()),
  loadRepoConfig:() => ipcRenderer.invoke('repos:config'),
  checkCommit: (repo, commit, branch) => ipcRenderer.invoke('repos:checkCommit', { repo, commit, branch }),
  branchGraph: (repo, branch, { fetch = false, all = false } = {}) =>
    ipcRenderer.invoke('repos:branchGraph', { repo, branch, fetch, all }),
  loadRepoSettings: () => ipcRenderer.invoke('repos:loadSettings'),
  saveRepoSettings: (repos) => ipcRenderer.invoke('repos:saveSettings', { repos }),
  pickRepoFolder: (defaultPath) => ipcRenderer.invoke('repos:pickFolder', defaultPath),
  loadEnvSettings: () => ipcRenderer.invoke('env:loadSettings'),
  /** values: { KEY: value }，空字串 = 從 .env 刪掉該 key */
  saveEnvSettings: (values) => ipcRenderer.invoke('env:saveSettings', { values }),
  openExternal: (url) => ipcRenderer.invoke('shell:open', url),
  /** 使用手冊（docs/user-guide.md）轉好的 HTML：{ html } */
  loadUserGuide: () => ipcRenderer.invoke('help:load'),
  exportLocalData: (localStorageItems) => ipcRenderer.invoke('localData:export', localStorageItems),
  pickImportZip: () => ipcRenderer.invoke('localData:pickImport'),
  applyImport: () => ipcRenderer.invoke('localData:applyImport'),
  /** 選單「檔案 → 匯出 / 匯入本地資料」被點擊時呼叫 cb('export' | 'import') */
  onLocalDataMenu: (cb) => ipcRenderer.on('menu:localData', (_e, action) => cb(action)),
  /** 選單「設定 → Repository 設定…」被點擊時呼叫 cb() */
  onRepoSettingsMenu: (cb) => ipcRenderer.on('menu:repoSettings', () => cb()),
  /** 選單「設定 → 連線與機密設定…」被點擊時呼叫 cb() */
  onEnvSettingsMenu: (cb) => ipcRenderer.on('menu:envSettings', () => cb()),
  /** 選單「設定 → UpAgent 連線設定…」被點擊時呼叫 cb() */
  onUpagentConnectionSettingsMenu: (cb) => ipcRenderer.on('menu:upagentConnectionSettings', () => cb()),
  /** 選單「設定 → UpAgent 發佈資料庫設定…」被點擊時呼叫 cb() */
  onUpagentReleaseDbSettingsMenu: (cb) => ipcRenderer.on('menu:upagentReleaseDbSettings', () => cb()),
  onProdRestartSettingsMenu: (cb) => ipcRenderer.on('menu:prodRestartSettings', () => cb()),
  /** 選單「說明 → 關於 AdoMaster」被點擊時呼叫 cb({ name, version }) */
  onAboutMenu: (cb) => ipcRenderer.on('menu:about', (_e, info) => cb(info)),
});
