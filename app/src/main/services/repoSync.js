const { CONFIG_FILE } = require('../paths');
const { runPowerShellJson } = require('../powershell');

/**
 * 雲端同步所有 repository（選單「工具 → 同步所有 Repository…」）：執行 shell/Sync-Repos.ps1，
 * 對 data/config.json 的 repos[].path（開發用 clone）與 localDeploy.repos.<key>.projectDir（部署用 clone）
 * git fetch --all，並把只落後 remote 的 local branch 快轉（分岔、upstream 已刪除的不動）。
 * fetchOnly = 只 fetch 並列出可快轉的 branch。
 * 一次只能執行一個；腳本的 stdout / stderr 即時以 'repoSync:log' 事件送給 renderer（每行一筆）。
 */

/** 目前執行中的同步：{ controller } */
let running = null;

async function runSync(send, { fetchOnly = false } = {}) {
  if (running) throw new Error('已有同步正在執行');
  const controller = new AbortController();
  running = { controller };
  let buffer = '';
  const onData = (text) => {
    buffer += text;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop();
    for (const line of lines) send('repoSync:log', { line });
  };
  try {
    const args = ['-ConfigPath', CONFIG_FILE];
    if (fetchOnly) args.push('-FetchOnly');
    return await runPowerShellJson('Sync-Repos.ps1', args, { timeout: 0, onStdout: onData, onStderr: onData, signal: controller.signal });
  } finally {
    if (buffer) send('repoSync:log', { line: buffer });
    running = null;
  }
}

function cancelSync() {
  running?.controller.abort();
}

module.exports = { runSync, cancelSync };
