const { app, BrowserWindow, dialog } = require('electron');
const { PRELOAD_FILE, RENDERER_HTML } = require('./paths');
const { registerIpcHandlers } = require('./ipc');
const { buildMenu } = require('./menu');
const { migrateLegacyConfig } = require('./services/appConfig');

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      preload: PRELOAD_FILE,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(RENDERER_HTML);
}

registerIpcHandlers();

app.whenReady().then(async () => {
  // 舊版設定檔（script/.env、data/repos.json、data/upagent_release.config）→ data/config.json + data/.env
  // 視窗還沒開，renderer 的 confirm-dialog 無法使用，失敗時只能用原生的錯誤視窗
  try {
    const migrated = await migrateLegacyConfig();
    if (migrated.length) console.log(`已轉換舊版設定檔（原檔改名為 *.bak）：${migrated.join('、')}`);
  } catch (err) {
    dialog.showErrorBox('設定檔轉換失敗', `舊版設定檔轉換到 data/config.json / data/.env 時失敗（舊檔仍保留，下次啟動會再轉換一次）：\n${err.message}`);
  }
  buildMenu();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
