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
 * @param {string} scriptName shell/ 底下的檔名，例如 'Restart-AppService.ps1'
 * @param {string[]} args 傳給腳本的參數，例如 ['-Name', 'foo', '-Force']
 * @param {object} [options]
 * @param {number} [options.timeout] 毫秒，0 = 不限時（預設 2 分鐘）
 * @param {(text: string) => void} [options.onStdout] 即時收到 stdout（長時間執行的腳本顯示進度用）
 * @param {(text: string) => void} [options.onStderr] 即時收到 stderr（docker / git 的進度輸出在 stderr）
 * @param {AbortSignal} [options.signal] abort 時以 taskkill /T 結束腳本與它啟動的子程序（git、az…）
 */
function runPowerShell(scriptName, args = [], { timeout = DEFAULT_TIMEOUT, onStdout, onStderr, signal } = {}) {
  const file = resolveScript(scriptName);
  const exe = process.env.POWERSHELL || 'powershell.exe';
  return new Promise((resolve, reject) => {
    const child = execFile(
      exe,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, ...args.map(String)],
      { cwd: SHELL_DIR, timeout, windowsHide: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        signal?.removeEventListener('abort', onAbort);
        if (!err) return resolve(String(stdout));
        if (signal?.aborted) err.message = `PowerShell 腳本 ${scriptName} 已停止`;
        else if (err.code === 'ENOENT') err.message = `找不到 PowerShell 執行檔（${exe}），可用環境變數 POWERSHELL 指定`;
        else if (err.killed) err.message = `PowerShell 腳本 ${scriptName} 執行逾時`;
        else if (String(stderr).trim()) err.message = String(stderr).trim();
        err.stdout = String(stdout || '');
        err.stderr = String(stderr || '');
        reject(err);
      }
    );
    // encoding 已設定，stdout 的 data 事件是字串（多位元組字元不會被切斷）
    if (onStdout) child.stdout.on('data', onStdout);
    if (onStderr) child.stderr.on('data', onStderr);
    // 只 kill powershell.exe 的話，它啟動的 git / az / signtool 仍會繼續跑，所以連同子程序一起結束
    function onAbort() {
      execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
    }
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
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

/** 腳本輸出的標記行：::<kind>::<value>（例：::step::Build、::error::訊息） */
const MARKER_RE = /^::([a-z]+)::(.*)$/i;

/** 把陸續收到的文字切成行交給 handle；flush() 送出最後一段沒有換行結尾的文字 */
function lineSplitter(handle) {
  let pending = '';
  return {
    push(text) {
      pending += text;
      const lines = pending.split(/\r?\n|\r/);
      pending = lines.pop();
      lines.forEach(handle);
    },
    flush() {
      if (pending) handle(pending);
      pending = '';
    },
  };
}

/**
 * 同 runPowerShellJson，但把輸出切成行即時處理（長時間執行、要顯示進度的腳本用）：
 *   - ::error::<訊息> → 失敗時以它取代錯誤訊息（比 stderr 精簡）
 *   - 其他 ::<kind>::<value> → onMarker(kind, value)
 *   - 一般行 → onLine(line)
 * @param options.stderr true = stderr 也照同樣規則處理（docker / git 的進度輸出在 stderr）
 * 其他 options 同 runPowerShell（timeout 預設 0 = 不限時）。
 */
async function runPowerShellLines(scriptName, args = [], { onLine, onMarker, stderr = false, timeout = 0, signal } = {}) {
  let lastError = '';
  const handle = (line) => {
    const m = MARKER_RE.exec(line.trim());
    if (!m) onLine?.(line);
    else if (m[1] === 'error') lastError = m[2].trim();
    else onMarker?.(m[1], m[2].trim());
  };
  const out = lineSplitter(handle);
  const err = stderr ? lineSplitter(handle) : null;
  const flush = () => {
    out.flush();
    err?.flush();
  };
  try {
    const result = await runPowerShellJson(scriptName, args, { timeout, signal, onStdout: out.push, onStderr: err?.push });
    flush();
    return result;
  } catch (e) {
    flush(); // 最後一行（可能就是 ::error::）沒有換行結尾時也要處理到
    if (!signal?.aborted && lastError) e.message = lastError;
    throw e;
  }
}

module.exports = { runPowerShellJson, runPowerShellLines };
