const { CONFIG_FILE } = require('../paths');
const { runPowerShellLines } = require('../powershell');
const { createExclusiveRunner } = require('../exclusiveRunner');

/**
 * 雲端同步所有 repository（選單「工具 → 同步所有 Repository…」）：執行 shell/Sync-Repos.ps1，
 * 對 data/config.json 的 repos[].path（開發用 clone）與 localDeploy.repos.<key>.projectDir（部署用 clone）
 * git fetch --all，並把只落後 remote 的 local branch 快轉（分岔、upstream 已刪除的不動）。
 * fetchOnly = 只 fetch 並列出可快轉的 branch。
 * 一次只能執行一個；腳本的 stdout / stderr 即時以 'repoSync:log' 事件送給 renderer（每行一筆）。
 */

const runner = createExclusiveRunner(() => '已有同步正在執行');

async function runSync(send, { fetchOnly = false } = {}) {
  const args = ['-ConfigPath', CONFIG_FILE];
  if (fetchOnly) args.push('-FetchOnly');
  return runner.run({}, null, (signal) =>
    runPowerShellLines('Sync-Repos.ps1', args, {
      stderr: true,
      onLine: (line) => send('repoSync:log', { line }),
      signal,
    }),
  );
}

function cancelSync() {
  runner.cancel();
}

module.exports = { runSync, cancelSync };
