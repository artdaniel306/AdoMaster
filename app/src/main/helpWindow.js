const { BrowserWindow, shell } = require('electron');
const { PRELOAD_FILE, HELP_HTML } = require('./paths');

/** 選單「說明 → 使用手冊」：獨立視窗（可邊看邊操作主視窗），已開啟時只帶到前面 */
let helpWin = null;

function openHelpWindow() {
  if (helpWin && !helpWin.isDestroyed()) {
    if (helpWin.isMinimized()) helpWin.restore();
    helpWin.focus();
    return;
  }
  helpWin = new BrowserWindow({
    width: 1000,
    height: 760,
    title: 'AdoMaster 使用手冊',
    autoHideMenuBar: true,
    webPreferences: { preload: PRELOAD_FILE, contextIsolation: true, nodeIntegration: false },
  });
  helpWin.setMenu(null);
  // 手冊只顯示本機頁面：外部連結一律交給系統瀏覽器，不在視窗內導覽
  const openOutside = (url) => {
    if (/^https:\/\//i.test(url)) shell.openExternal(url);
  };
  helpWin.webContents.setWindowOpenHandler(({ url }) => {
    openOutside(url);
    return { action: 'deny' };
  });
  helpWin.webContents.on('will-navigate', (e, url) => {
    e.preventDefault();
    openOutside(url);
  });
  helpWin.on('closed', () => {
    helpWin = null;
  });
  helpWin.loadFile(HELP_HTML);
}

module.exports = { openHelpWindow };
