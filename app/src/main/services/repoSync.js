const { CONFIG_FILE } = require('../paths');
const { runPowerShellLines } = require('../powershell');
const { createExclusiveRunner } = require('../exclusiveRunner');
const { withPathLock } = require('../pathLock');
const { readConfig, isObj } = require('./appConfig');

/**
 * 雲端同步所有 repository（選單「Git → 同步所有 Repository…」）：執行 shell/Sync-Repos.ps1，
 * 對 data/config.json 的 repos[].path（開發用 clone）與 localDeploy.repos.<key>.projectDir（部署用 clone）
 * git fetch --all，並把只落後 remote 的 local branch 快轉（分岔、upstream 已刪除的不動）。
 * fetchOnly = 只 fetch 並列出可快轉的 branch。
 * 一次只能執行一個；腳本的 stdout / stderr 即時以 'repoSync:log' 事件送給 renderer（每行一筆）。
 * 執行期間佔用所有會同步的資料夾（pathLock）：先等 App 對它們的 git 操作 / Local 佈版結束，同步完之前 App 的 git 操作也會等待。
 */

const runner = createExclusiveRunner(() => '已有同步正在執行');

/** Sync-Repos.ps1 會處理的資料夾：repos[].path（開發用 clone）與 localDeploy.repos.<key>.projectDir（部署用 clone） */
async function syncPaths() {
  const config = (await readConfig()) || {};
  const dev = (Array.isArray(config.repos) ? config.repos : []).map((r) => r?.path);
  const deployRepos = isObj(config.localDeploy?.repos) ? Object.values(config.localDeploy.repos) : [];
  const deploy = deployRepos.map((r) => (isObj(r) ? r.projectDir : null));
  return [...dev, ...deploy].filter((p) => typeof p === 'string' && p.trim()).map((p) => p.trim());
}

async function runSync(send, { fetchOnly = false } = {}) {
  const args = ['-ConfigPath', CONFIG_FILE];
  if (fetchOnly) args.push('-FetchOnly');
  const log = (line) => send('repoSync:log', { line });
  return runner.run({}, null, async (signal) =>
    withPathLock(await syncPaths(), () => runPowerShellLines('Sync-Repos.ps1', args, { stderr: true, onLine: log, signal }), {
      signal,
      onWait: () => log('⏳ 等待其他 git 操作 / Local 佈版結束…'),
    }),
  );
}

function cancelSync() {
  runner.cancel();
}

module.exports = { runSync, cancelSync };
