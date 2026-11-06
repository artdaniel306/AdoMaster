const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PythonShell } = require('python-shell');
const { SCRIPT_DIR } = require('./paths');

/** 透過 python-shell 執行 script/ 底下的 Python 腳本；exit code 非 0 時 reject（訊息為 stderr）。 */
function runScript(scriptName, args = []) {
  return PythonShell.run(scriptName, {
    scriptPath: SCRIPT_DIR,
    pythonPath: process.env.PYTHON, // 未設定時使用 python-shell 預設（Windows: python，其他: python3）
    args,
    cwd: SCRIPT_DIR,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    windowsHide: true,
  });
}

/** 不會重複的暫存檔路徑（每次請求各用一個，避免同時執行時互相覆寫） */
const tempFile = (ext) => path.join(os.tmpdir(), `ado-master-${randomUUID()}.${ext}`);

/** 刪除暫存檔（不等待、忽略錯誤） */
const removeTemp = (file) => fs.rm(file, { force: true }).catch(() => {});

/**
 * 執行腳本並讀回它以 `--out <暫存檔>` 輸出的 JSON（腳本的 stdout 是進度訊息，不適合直接當結果）。
 * 暫存檔用完即刪除。
 */
async function runScriptJson(scriptName, args = []) {
  const out = tempFile('json');
  try {
    await runScript(scriptName, [...args, '--out', out]);
    return JSON.parse(await fs.readFile(out, 'utf-8'));
  } finally {
    removeTemp(out);
  }
}

module.exports = { runScript, runScriptJson, tempFile, removeTemp };
