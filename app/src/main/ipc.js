const { ipcMain, shell } = require('electron');
const iterations = require('./services/iterations');
const workItems = require('./services/workItems');
const requirementFlow = require('./services/requirementFlow');
const repoConfig = require('./services/repoConfig');
const gitCommit = require('./services/gitCommit');

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
  ipcMain.handle('flow:loadState', () => requirementFlow.loadFlowState());
  ipcMain.handle('flow:setCheck', (_e, params) => requirementFlow.setFlowCheck(params));
  ipcMain.handle('flow:setUnderstand', (_e, params) => requirementFlow.setUnderstand(params));
  ipcMain.handle('flow:setCommits', (_e, params) => requirementFlow.setCommits(params));
  ipcMain.handle('flow:mergeStatus', (_e, { id, stage } = {}) => requirementFlow.deployMergeStatus({ id, stage }));
  ipcMain.handle('flow:mergeDeploy', (_e, { id, stage } = {}) => requirementFlow.mergeDeploy({ id, stage }));
  ipcMain.handle('repos:config', () => repoConfig.loadRepoConfig());
  ipcMain.handle('repos:checkCommit', (_e, params) => gitCommit.checkCommit(params));

  ipcMain.handle('shell:open', (_e, url) => {
    if (typeof url === 'string' && /^https:\/\//i.test(url)) return shell.openExternal(url);
  });
}

module.exports = { registerIpcHandlers };
