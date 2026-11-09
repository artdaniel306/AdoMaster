const { BrowserWindow, ipcMain, shell } = require('electron');
const localData = require('./services/localData');
const iterations = require('./services/iterations');
const workItems = require('./services/workItems');
const requirementFlow = require('./services/requirementFlow');
const flowState = require('./services/flowState');
const repoConfig = require('./services/repoConfig');
const gitCommit = require('./services/gitCommit');
const pipelines = require('./services/pipelines');
const afterDeploy = require('./services/afterDeploy');
const testRecord = require('./services/testRecord');
const upagentRelease = require('./services/upagentRelease');
const localDeploy = require('./services/localDeploy');

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
  ipcMain.handle('repos:config', () => repoConfig.loadRepoConfig());
  ipcMain.handle('repos:checkCommit', (_e, params) => gitCommit.checkCommit(params));
  ipcMain.handle('repos:branchGraph', (_e, params) => gitCommit.branchGraph(params));

  const senderWindow = (e) => BrowserWindow.fromWebContents(e.sender);
  ipcMain.handle('repos:loadSettings', () => repoConfig.loadRepoSettings());
  ipcMain.handle('repos:saveSettings', (_e, params) => repoConfig.saveRepoSettings(params));
  ipcMain.handle('repos:pickFolder', (e, defaultPath) => repoConfig.pickRepoFolder(senderWindow(e), defaultPath));
  ipcMain.handle('localData:export', (e, localStorageItems) => localData.exportLocalData(senderWindow(e), localStorageItems));
  ipcMain.handle('localData:pickImport', (e) => localData.pickImportZip(senderWindow(e)));
  ipcMain.handle('localData:applyImport', () => localData.applyImport());

  ipcMain.handle('shell:open', (_e, url) => {
    if (typeof url === 'string' && /^https:\/\//i.test(url)) return shell.openExternal(url);
  });
}

module.exports = { registerIpcHandlers };
