const fs = require('fs');
const { app, Menu, shell } = require('electron');
const { openHelpWindow } = require('./helpWindow');
const { DATA_DIR } = require('./paths');

/** 用檔案總管開啟 data 資料夾（paths.DATA_DIR，即 app 實際讀寫設定的位置）；不存在時先建立。 */
async function openDataFolder() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const err = await shell.openPath(DATA_DIR);
    if (err) console.error(`無法開啟設定資料夾 ${DATA_DIR}：${err}`);
  } catch (e) {
    console.error(`無法開啟設定資料夾 ${DATA_DIR}：${e.message}`);
  }
}

/**
 * 選單列：「檔案」放匯出 / 匯入本地資料（只通知 renderer，流程與 dialog 在 renderer 的 local-data.js），
 * 「設定」放連線與機密設定（data/.env，env-settings-dialog.js）、Repository 設定（repo-settings-dialog.js）
 * 、UpAgent 連線設定（upagent-connection-settings-dialog.js）、UpAgent 發佈資料庫設定（upagent-release-db-dialog.js）
 * 與正式環境排程重啟設定（prod-restart-settings-dialog.js），以及「開啟設定資料夾」（main 直接用檔案總管開啟 DATA_DIR），
 * 「佈版」放手動佈版（manual-deploy-dialog.js）、佈版進度（deploy-progress-dialog.js）與正式環境排程重啟（restart-schedule-dialog.js），
 * 「工具」放同步所有 Repository（repo-sync-dialog.js），
 * 同樣只通知 renderer，
 * 「說明 → 使用手冊」（F1）由 main 直接開獨立視窗（helpWindow.js，內容是 docs/user-guide.md），
 * 「說明 → 關於 AdoMaster」把版本號（package.json version）傳給 renderer，用 app 內的 confirm dialog 顯示，
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
        { label: '正式環境排程重啟設定…', click: (_item, win) => win?.webContents.send('menu:prodRestartSettings') },
        { type: 'separator' },
        { label: '開啟設定資料夾', click: () => openDataFolder() },
      ],
    },
    {
      label: '佈版',
      submenu: [
        { label: '手動佈版…', click: (_item, win) => win?.webContents.send('menu:deploy', 'manual') },
        { label: '佈版進度…', click: (_item, win) => win?.webContents.send('menu:deploy', 'progress') },
        { type: 'separator' },
        { label: '正式環境排程重啟…', click: (_item, win) => win?.webContents.send('menu:deploy', 'restart') },
      ],
    },
    {
      label: '工具',
      submenu: [{ label: '同步所有 Repository…', click: (_item, win) => win?.webContents.send('menu:repoSync') }],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      label: '說明',
      role: 'help',
      submenu: [
        { label: '使用手冊', accelerator: 'F1', click: () => openHelpWindow() },
        { type: 'separator' },
        {
          label: '關於 AdoMaster',
          click: (_item, win) => win?.webContents.send('menu:about', { name: app.getName(), version: app.getVersion() }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

module.exports = { buildMenu };
