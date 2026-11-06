// pm2 設定檔：在 app/ 目錄下執行 `pm2 start ecosystem.config.js`（或直接 `pm2 start`）啟動 Electron App。
// 以 node 執行 electron 套件的 cli.js（等同 `npm start` / `electron .`），避免在 Windows 上透過 npm.cmd 啟動的問題。
module.exports = {
  apps: [
    {
      name: 'ado-master',
      cwd: __dirname,
      script: 'node_modules/electron/cli.js',
      args: '.',
      interpreter: 'node',
      // 使用者關閉視窗即代表結束 App，不要自動重啟
      autorestart: false,
      watch: false,
      env: {
        NODE_ENV: 'production',
        // PYTHON: 'C:\\Python312\\python.exe', // 需要指定 python 執行檔時取消註解
      },
    },
  ],
};
