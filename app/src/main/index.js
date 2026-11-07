const { app, BrowserWindow } = require('electron');
const { PRELOAD_FILE, RENDERER_HTML } = require('./paths');
const { registerIpcHandlers } = require('./ipc');
const { buildMenu } = require('./menu');

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

app.whenReady().then(() => {
  buildMenu();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
