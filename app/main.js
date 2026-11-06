const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { PythonShell } = require('python-shell');

const ROOT_DIR = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const SCRIPT_DIR = path.join(ROOT_DIR, 'script');
const ITERATIONS_FILE = path.join(DATA_DIR, 'iterations.json');

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile('index.html');
}

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

async function readIterations() {
  try {
    return JSON.parse(await fs.readFile(ITERATIONS_FILE, 'utf-8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

// 讀取 data/iterations.json（扁平清單，renderer 端組成樹狀）
ipcMain.handle('iterations:load', () => readIterations());

// 重新執行 get_iterations.py 同步 Iteration，再讀回
ipcMain.handle('iterations:sync', async () => {
  await runScript('get_iterations.py');
  return readIterations();
});

// 執行 get_iteration_work_items.py 抓取指定 Iteration 的 Work Item
ipcMain.handle('workitems:fetch', async (_e, { iterationPath, exact }) => {
  if (typeof iterationPath !== 'string' || !iterationPath) throw new Error('缺少 iterationPath');
  // 每次請求用獨立暫存檔，避免同時查詢互相覆寫
  const out = path.join(os.tmpdir(), `ado-master-wi-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  const args = ['--iteration', iterationPath, '--out', out];
  if (exact) args.push('--exact');
  try {
    await runScript('get_iteration_work_items.py', args);
    return JSON.parse(await fs.readFile(out, 'utf-8'));
  } finally {
    fs.rm(out, { force: true }).catch(() => {});
  }
});

ipcMain.handle('shell:open', (_e, url) => {
  if (typeof url === 'string' && /^https:\/\//i.test(url)) return shell.openExternal(url);
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
