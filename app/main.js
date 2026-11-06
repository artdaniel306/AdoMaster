const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const os = require('node:os');

function createWindow() {
  const win = new BrowserWindow({
    width: 900,
    height: 640,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile('index.html');
}

// IPC：讓 renderer 透過 preload 取得系統資訊
ipcMain.handle('get-system-info', () => ({
  platform: `${os.type()} ${os.release()}`,
  arch: os.arch(),
  cpus: os.cpus().length,
  memoryGB: (os.totalmem() / 1024 ** 3).toFixed(1),
  hostname: os.hostname(),
}));

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
