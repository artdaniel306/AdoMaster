const { Menu } = require('electron');

/**
 * 選單列：「檔案」放匯出 / 匯入本地資料（只通知 renderer，流程與 dialog 在 renderer 的 local-data.js），
 * 「設定」放 Repository 設定（同樣只通知 renderer，dialog 在 repo-settings-dialog.js），
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
        { label: 'Repository 設定…', click: (_item, win) => win?.webContents.send('menu:repoSettings') },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

module.exports = { buildMenu };
