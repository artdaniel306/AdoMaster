const { BrowserWindow, ipcMain, shell } = require('electron');
const localData = require('./services/localData');
const iterations = require('./services/iterations');
const workItems = require('./services/workItems');
const requirementFlow = require('./services/requirementFlow');
const flowState = require('./services/flowState');
const repoConfig = require('./services/repoConfig');
const appConfig = require('./services/appConfig');
const gitCommit = require('./services/gitCommit');
const pipelines = require('./services/pipelines');
const afterDeploy = require('./services/afterDeploy');
const testRecord = require('./services/testRecord');
const upagentRelease = require('./services/upagentRelease');
const localDeploy = require('./services/localDeploy');
const upagentConnection = require('./services/upagentConnection');
const upagentReleaseDb = require('./services/upagentReleaseDb');
const userGuide = require('./services/userGuide');
const manualDeploy = require('./services/manualDeploy');

/**
 * IPC channel → service 對照。renderer 只能透過 preload 暴露的 window.api 呼叫這些 channel。
 * 新增功能時：services/ 寫邏輯 → 這裡註冊 channel → preload 加一個對應方法。
 */
function registerIpcHandlers() {
  ipcMain.handle('iterations:load', () => iterations.loadIterations());
  ipcMain.handle('iterations:sync', () => iterations.syncIterations());

  ipcMain.handle('workitems:fetch', (_e, params) => workItems.fetchWorkItems(params));

  ipcMain.handle('flow:fetch', (_e, params) => requirementFlow.fetchRequirementFlow(params));
  ipcMain.handle('flow:createTask', (_e, params) => requirementFlow.createDefaultTask(params));
  ipcMain.handle('flow:updateState', (_e, params) => requirementFlow.updateRequirementStateInAdo(params));
  ipcMain.handle('flow:loadState', () => flowState.loadFlowState());
  ipcMain.handle('flow:setCheck', (_e, params) => requirementFlow.setFlowCheck(params));
  ipcMain.handle('flow:setPlan', (_e, params) => requirementFlow.setPlan(params));
  ipcMain.handle('flow:setCommits', (_e, params) => requirementFlow.setCommits(params));
  ipcMain.handle('flow:setTestRecord', (_e, params) => testRecord.saveTestRecord(params));
  ipcMain.handle('flow:testImages', (_e, params) => testRecord.loadTestImages(params));
  ipcMain.handle('flow:mergeStatus', (_e, { id, stage } = {}) => requirementFlow.deployMergeStatus({ id, stage }));
  ipcMain.handle('flow:mergeDeploy', (_e, { id, stage } = {}) => requirementFlow.mergeDeploy({ id, stage }));
  ipcMain.handle('flow:pipelineRuns', (_e, { id, stage } = {}) => pipelines.deployPipelineRuns({ id, stage }));
  ipcMain.handle('flow:afterDeploy', (_e, params) => afterDeploy.runAfterDeploy(params));
  ipcMain.handle('upagentRelease:status', (_e, { id, stage, target } = {}) => upagentRelease.releaseStatus({ id, stage, target }));
  ipcMain.handle('upagentRelease:run', (e, params) =>
    upagentRelease.runRelease((channel, payload) => !e.sender.isDestroyed() && e.sender.send(channel, payload), params)
  );
  ipcMain.handle('upagentRelease:cancel', () => upagentRelease.cancelRelease());
  ipcMain.handle('localDeploy:status', (_e, { id, stage } = {}) => localDeploy.localDeployStatus({ id, stage }));
  ipcMain.handle('localDeploy:run', (e, params) =>
    localDeploy.runLocalDeploy((channel, payload) => !e.sender.isDestroyed() && e.sender.send(channel, payload), params)
  );
  ipcMain.handle('localDeploy:cancel', () => localDeploy.cancelLocalDeploy());
  // 手動佈版（選單「佈版」）：進度以 manualDeploy:update / manualDeploy:log 廣播給所有視窗
  ipcMain.handle('manualDeploy:preview', (_e, params) => manualDeploy.preview(params));
  ipcMain.handle('manualDeploy:start', (_e, params) => manualDeploy.start(params));
  ipcMain.handle('manualDeploy:cancel', (_e, { id } = {}) => manualDeploy.cancel({ id }));
  ipcMain.handle('manualDeploy:retry', (_e, { id, rerunAction } = {}) => manualDeploy.retry({ id, rerunAction }));
  ipcMain.handle('manualDeploy:dismiss', (_e, { id } = {}) => manualDeploy.dismiss({ id }));
  ipcMain.handle('manualDeploy:list', () => manualDeploy.list());
  ipcMain.handle('upagentConnection:status', () => upagentConnection.connectionStatus());
  ipcMain.handle('upagentConnection:switch', (_e, { target } = {}) => upagentConnection.switchConnection({ target }));
  ipcMain.handle('upagentConnection:loadSettings', () => upagentConnection.loadConnectionSettings());
  ipcMain.handle('upagentConnection:saveSettings', (_e, params) => upagentConnection.saveConnectionSettings(params));
  ipcMain.handle('upagentConnection:pickFile', (e, current) => upagentConnection.pickConfigFile(BrowserWindow.fromWebContents(e.sender), current));
  ipcMain.handle('upagentReleaseDb:loadSettings', () => upagentReleaseDb.loadReleaseDbSettings());
  ipcMain.handle('upagentReleaseDb:saveSettings', (_e, params) => upagentReleaseDb.saveReleaseDbSettings(params));
  ipcMain.handle('upagentReleaseDb:pickPsql', (e, current) => upagentReleaseDb.pickPsql(BrowserWindow.fromWebContents(e.sender), current));
  ipcMain.handle('repos:config', () => repoConfig.loadRepoConfig());
  ipcMain.handle('repos:checkCommit', (_e, params) => gitCommit.checkCommit(params));
  ipcMain.handle('repos:branchGraph', (_e, params) => gitCommit.branchGraph(params));

  const senderWindow = (e) => BrowserWindow.fromWebContents(e.sender);
  ipcMain.handle('repos:loadSettings', () => repoConfig.loadRepoSettings());
  ipcMain.handle('repos:saveSettings', (_e, params) => repoConfig.saveRepoSettings(params));
  ipcMain.handle('repos:pickFolder', (e, defaultPath) => repoConfig.pickRepoFolder(senderWindow(e), defaultPath));
  ipcMain.handle('env:loadSettings', () => appConfig.loadEnvSettings());
  ipcMain.handle('env:saveSettings', (_e, params) => appConfig.saveEnvSettings(params));
  ipcMain.handle('localData:export', (e, localStorageItems) => localData.exportLocalData(senderWindow(e), localStorageItems));
  ipcMain.handle('localData:pickImport', (e) => localData.pickImportZip(senderWindow(e)));
  ipcMain.handle('localData:applyImport', () => localData.applyImport());

  ipcMain.handle('help:load', () => userGuide.loadUserGuide());
  ipcMain.handle('shell:open', (_e, url) => {
    if (typeof url === 'string' && /^https:\/\//i.test(url)) return shell.openExternal(url);
  });
}

module.exports = { registerIpcHandlers };
