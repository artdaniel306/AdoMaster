const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { SHELL_DIR } = require('./paths');
const { tempFile, removeTemp } = require('./python');

/**
 * 執行 shell/ 底下的 PowerShell 腳本（.ps1）。慣例與 python.js 相同：
 * 進度訊息走 stdout，結果以 JSON 寫到 `-Out <檔案>`，失敗時 stderr + exit code 非 0。
 *
 * 執行檔預設為 Windows PowerShell（powershell.exe）；設定環境變數 POWERSHELL 可改用 pwsh 等。
 * 直接用 Node 內建 child_process.execFile：每次呼叫都是一次性的 `-File` 執行，
 * 不需要 node-powershell 這類維持互動 session 的套件。
 */

const DEFAULT_TIMEOUT = 120_000;

/** 只允許 shell/ 底下的 .ps1 檔名（不可含路徑），避免被拿來執行任意檔案 */
function resolveScript(scriptName) {
  if (typeof scriptName !== 'string' || !/^[\w.-]+\.ps1$/i.test(scriptName) || scriptName !== path.basename(scriptName)) {
    throw new Error(`PowerShell 腳本名稱不正確：${scriptName}`);
  }
  return path.join(SHELL_DIR, scriptName);
}

/**
 * 執行腳本，回傳 stdout（字串）。exit code 非 0 時 reject，訊息為 stderr。
 * @param {string} scriptName shell/ 底下的檔名，例如 'example.ps1'
 * @param {string[]} args 傳給腳本的參數，例如 ['-Name', 'foo', '-Force']
 */
function runPowerShell(scriptName, args = [], { timeout = DEFAULT_TIMEOUT } = {}) {
  const file = resolveScript(scriptName);
  const exe = process.env.POWERSHELL || 'powershell.exe';
  return new Promise((resolve, reject) => {
    execFile(
      exe,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, ...args.map(String)],
      { cwd: SHELL_DIR, timeout, windowsHide: true, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (!err) return resolve(String(stdout));
        if (err.code === 'ENOENT') err.message = `找不到 PowerShell 執行檔（${exe}），可用環境變數 POWERSHELL 指定`;
        else if (err.killed) err.message = `PowerShell 腳本 ${scriptName} 執行逾時`;
        else if (String(stderr).trim()) err.message = String(stderr).trim();
        err.stdout = String(stdout || '');
        err.stderr = String(stderr || '');
        reject(err);
      }
    );
  });
}

/** 執行腳本並讀回它以 `-Out <暫存檔>` 輸出的 JSON；暫存檔用完即刪除。 */
async function runPowerShellJson(scriptName, args = [], options) {
  const out = tempFile('json');
  try {
    await runPowerShell(scriptName, [...args, '-Out', out], options);
    // Windows PowerShell 5.1 的 Out-File / Set-Content 會加 BOM，保險起見去掉
    return JSON.parse((await fs.readFile(out, 'utf-8')).replace(/^﻿/, ''));
  } finally {
    removeTemp(out);
  }
}

module.exports = { runPowerShell, runPowerShellJson };
