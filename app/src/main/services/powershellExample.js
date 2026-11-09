const { runPowerShellJson } = require('../powershell');

/**
 * 範例：呼叫 shell/example.ps1，回傳它輸出的 JSON。
 * 之後要接真正的 PowerShell 功能時，照這個樣子在 services/ 加一個模組即可。
 */
function runExample({ name } = {}) {
  const args = [];
  if (typeof name === 'string' && name.trim()) args.push('-Name', name.trim());
  return runPowerShellJson('example.ps1', args);
}

module.exports = { runExample };
