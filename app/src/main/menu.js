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
 * 選單列：
 * 「設定」放連線與機密設定（data/.env，env-settings-dialog.js）、Repository 設定（repo-settings-dialog.js）
 * 、UpAgent 連線設定（upagent-connection-settings-dialog.js）、UpAgent 發佈資料庫設定（upagent-release-db-dialog.js）
 * 與正式環境排程重啟設定（prod-restart-settings-dialog.js）；分隔線後是匯出 / 匯入本地資料（只通知 renderer，流程與 dialog 在 renderer 的 local-data.js），
 * 再一條分隔線後是「開啟設定資料夾」（main 直接用檔案總管開啟 DATA_DIR），
 * 「版本控制」放手動佈版（manual-deploy-dialog.js）、佈版進度（deploy-progress-dialog.js）、監視 SaaS 佈版狀態（saas-monitor-dialog.js）、查看客戶發佈版本（customer-images-dialog.js），
 * 分隔線後是正式環境排程重啟（restart-schedule-dialog.js），再一條分隔線後是 Git：同步所有 Repository（repo-sync-dialog.js）與同步 prod 至 feature（prod-sync-dialog.js），
 * 「開發指標」放流程提醒（reminders-dialog.js：誰被提醒過、幾次、哪些 Task），
 * 同樣只通知 renderer，
 * 「說明 → 使用手冊」（F1）由 main 直接開獨立視窗（helpWindow.js，內容是 docs/user-guide.md），
 * 「說明 → 關於 AdoMaster」把版本號（package.json version）傳給 renderer，用 app 內的 confirm dialog 顯示。
 * 不放 Electron 預設的 Edit / View / Window 選單；macOS 的剪貼簿快捷鍵需要 Edit 選單，所以只在 macOS 保留。
 */
function buildMenu() {
  const isMac = process.platform === 'darwin';
  const send = (action) => (_item, win) => win?.webContents.send('menu:localData', action);
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: '設定',
      submenu: [
        { label: '連線與機密設定…', click: (_item, win) => win?.webContents.send('menu:envSettings') },
        { label: 'Repository 設定…', click: (_item, win) => win?.webContents.send('menu:repoSettings') },
        { label: 'UpAgent 連線設定…', click: (_item, win) => win?.webContents.send('menu:upagentConnectionSettings') },
        { label: 'UpAgent 發佈資料庫設定…', click: (_item, win) => win?.webContents.send('menu:upagentReleaseDbSettings') },
        { label: '正式環境排程重啟設定…', click: (_item, win) => win?.webContents.send('menu:prodRestartSettings') },
        { type: 'separator' },
        { label: '匯出本地資料…', click: send('export') },
        { label: '匯入本地資料…', click: send('import') },
        { type: 'separator' },
        { label: '開啟設定資料夾', click: () => openDataFolder() },
      ],
    },
    {
      label: '版本控制',
      submenu: [
        { label: '同步所有 Repository…', click: (_item, win) => win?.webContents.send('menu:repoSync') },
        { label: '同步 prod 至 feature…', click: (_item, win) => win?.webContents.send('menu:prodSync') },
        { type: 'separator' },
        { label: '手動佈版…', click: (_item, win) => win?.webContents.send('menu:deploy', 'manual') },
        { label: '佈版進度…', click: (_item, win) => win?.webContents.send('menu:deploy', 'progress') },
        { label: '監視 SaaS 佈版狀態…', click: (_item, win) => win?.webContents.send('menu:deploy', 'saasMonitor') },
        { label: '查看客戶發佈版本…', click: (_item, win) => win?.webContents.send('menu:deploy', 'customerImages') },
        { type: 'separator' },
        { label: '正式環境排程重啟…', click: (_item, win) => win?.webContents.send('menu:deploy', 'restart') },
      ],
    },
    {
      label: '開發指標',
      submenu: [
        { label: '流程提醒…', click: (_item, win) => win?.webContents.send('menu:metrics', 'reminders') },
      ],
    },
    ...(isMac ? [{ role: 'editMenu' }] : []),
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
