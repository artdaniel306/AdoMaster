const { Menu } = require('electron');
const { openHelpWindow } = require('./helpWindow');

/**
 * 選單列：「檔案」放匯出 / 匯入本地資料（只通知 renderer，流程與 dialog 在 renderer 的 local-data.js），
 * 「設定」放連線與機密設定（data/.env，env-settings-dialog.js）、Repository 設定（repo-settings-dialog.js）
 * 、UpAgent 連線設定（upagent-connection-settings-dialog.js）與 UpAgent 發佈資料庫設定（upagent-release-db-dialog.js），同樣只通知 renderer，
 * 「說明 → 使用手冊」（F1）由 main 直接開獨立視窗（helpWindow.js，內容是 docs/user-guide.md），
 * 其餘沿用 Electron 預設的編輯 / 檢視 / 視窗選單。
 */
function buildMenu() {
  const isMac = process.platform === 'darwin';
  const send = (action) => (_item, win) => win?.webContents.send('menu:localData', action);
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: '檔案',
      submenu: [
        { label: '匯出本地資料…', click: send('export') },
        { label: '匯入本地資料…', click: send('import') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit', label: '結束' },
      ],
    },
    {
      label: '設定',
      submenu: [
        { label: '連線與機密設定…', click: (_item, win) => win?.webContents.send('menu:envSettings') },
        { label: 'Repository 設定…', click: (_item, win) => win?.webContents.send('menu:repoSettings') },
        { label: 'UpAgent 連線設定…', click: (_item, win) => win?.webContents.send('menu:upagentConnectionSettings') },
        { label: 'UpAgent 發佈資料庫設定…', click: (_item, win) => win?.webContents.send('menu:upagentReleaseDbSettings') },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      label: '說明',
      role: 'help',
      submenu: [{ label: '使用手冊', accelerator: 'F1', click: () => openHelpWindow() }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

module.exports = { buildMenu };
