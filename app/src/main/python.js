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

module.exports = { runScript };
