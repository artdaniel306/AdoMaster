import { $ } from './dom.js';
import { createIterationTree } from './iteration-tree.js';
import { createWorkItemsView } from './work-items.js';
import { createRequirementFlowView } from './requirement-flow.js';
import { initSidebarToggle } from './sidebar-toggle.js';
import { initLocalData } from './local-data.js';
import { initRepoSettings } from './repo-settings-dialog.js';
import { initEnvSettings } from './env-settings-dialog.js';
import { initUpagentConnectionSettings } from './upagent-connection-settings-dialog.js';
import { initUpagentReleaseDbSettings } from './upagent-release-db-dialog.js';
import { createManualDeployDialog } from './manual-deploy-dialog.js';
import { createDeployProgressDialog } from './deploy-progress-dialog.js';
import { createRestartScheduleDialog } from './restart-schedule-dialog.js';
import { createSaasMonitorDialog } from './saas-monitor-dialog.js';
import { initProdRestartSettings } from './prod-restart-settings-dialog.js';
import { createRepoSyncDialog } from './repo-sync-dialog.js';
import { createProdSyncDialog } from './prod-sync-dialog.js';
import { createConfirmDialog } from './confirm-dialog.js';
import { api } from './api.js';

const exactEl = $('exact');
const views = {
  flow: { view: createRequirementFlowView(), panel: $('view-flow'), loadedKey: null },
  items: { view: createWorkItemsView(), panel: $('view-items'), loadedKey: null },
};
let current = 'flow';

/** 目前分頁若還沒載入過這個 Iteration（或「不含子 Iteration」有變）才重新查詢 */
function refresh(force = false) {
  const node = tree.getSelected();
  if (!node) return;
  const key = `${node.iterationPath}|${exactEl.checked}`;
  const v = views[current];
  if (!force && v.loadedKey === key) return;
  v.loadedKey = key;
  v.view.show(node, exactEl.checked);
}

const tree = createIterationTree({
  onSelect: (node) => {
    $('wi-title').textContent = node.name;
    $('wi-sub').textContent = node.iterationPath + (node.startDate ? `　(${node.startDate} ~ ${node.finishDate})` : '');
    refresh(true);
  },
});

exactEl.addEventListener('change', () => refresh());

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    current = tab.dataset.view;
    for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t === tab);
    for (const [name, v] of Object.entries(views)) v.panel.hidden = name !== current;
    refresh();
  });
}

initSidebarToggle();
initLocalData();
initRepoSettings({ onSaved: () => views.flow.view.repaint() });
initEnvSettings();
initUpagentConnectionSettings();
initUpagentReleaseDbSettings();
const prodRestartSettings = initProdRestartSettings();
createRepoSyncDialog(); // 選單「Git → 同步所有 Repository…」
createProdSyncDialog(); // 選單「Git → 同步 prod 至 feature…」

// 佈版（選單「佈版」與標題列按鈕）：手動佈版 + 佈版進度
const progress = createDeployProgressDialog({ openManual: () => manualDeploy.open(), badgeEl: $('deploy-progress-count') });
const manualDeploy = createManualDeployDialog({ onStarted: (job) => progress.started(job) });
$('manual-deploy-btn').addEventListener('click', () => manualDeploy.open());
$('deploy-progress-btn').addEventListener('click', () => progress.open());
const restartSchedule = createRestartScheduleDialog({ openSettings: (onSaved) => prodRestartSettings.open(onSaved) });
const saasMonitor = createSaasMonitorDialog({ openRestartSchedule: () => restartSchedule.open() });
const DEPLOY_MENU = { manual: manualDeploy, restart: restartSchedule, saasMonitor, progress };
api.onDeployMenu((action) => (DEPLOY_MENU[action] || progress).open());

tree.load();

api.onAboutMenu(({ name, version }) => createConfirmDialog().alert(`關於 ${name}`, `版本 ${version}`));
