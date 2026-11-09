const path = require('node:path');
const { app } = require('electron');

/**
 * 路徑分兩種執行模式：
 * - 開發（npm start）：ROOT_DIR = 專案根目錄，script/、shell/、data/ 都在底下。
 * - 安裝版（electron-builder 打包）：script/、shell/ 由 extraResources 放在 resources/（asar 外，Python / PowerShell 才讀得到）；
 *   data/ 放在使用者資料夾（%APPDATA%\AdoMaster\data），升級 / 解除安裝不會被刪掉。
 * 兩種模式都可用環境變數 ADOMASTER_DATA_DIR 指定 data 資料夾（例如讓安裝版共用專案的 data/）。
 * 決定後寫回 process.env.ADOMASTER_DATA_DIR，讓 Python（ado/config.py）與 PowerShell 腳本沿用同一個位置。
 */
const ROOT_DIR = app.isPackaged ? process.resourcesPath : path.resolve(__dirname, '..', '..', '..'); // app/src/main → 專案根目錄
const APP_SRC_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.resolve(
  process.env.ADOMASTER_DATA_DIR || (app.isPackaged ? path.join(app.getPath('userData'), 'data') : path.join(ROOT_DIR, 'data')),
);
process.env.ADOMASTER_DATA_DIR = DATA_DIR;

module.exports = {
  ROOT_DIR,
  DATA_DIR,
  SCRIPT_DIR: path.join(ROOT_DIR, 'script'),
  SHELL_DIR: path.join(ROOT_DIR, 'shell'),
  ITERATIONS_FILE: path.join(DATA_DIR, 'iterations.json'),
  FLOW_STATE_FILE: path.join(DATA_DIR, 'requirement_flow_state.json'),
  TEST_RECORDS_DIR: path.join(DATA_DIR, 'test_records'),
  // Local 佈版各環境的 env 檔（localDeploy.repos.<repo>.<test|prod>.envFile 的相對路徑基準）
  LOCAL_DEPLOY_ENV_DIR: path.join(DATA_DIR, 'local_deploy_env'),
  // 本機設定（見 services/appConfig.js）
  CONFIG_FILE: path.join(DATA_DIR, 'config.json'),
  ENV_FILE: path.join(DATA_DIR, '.env'),
  // 舊版設定檔：啟動時自動轉換到 CONFIG_FILE / ENV_FILE
  LEGACY_ENV_FILE: path.join(ROOT_DIR, 'script', '.env'),
  LEGACY_REPOS_FILE: path.join(DATA_DIR, 'repos.json'),
  LEGACY_UPAGENT_CONFIG_FILE: path.join(DATA_DIR, 'upagent_release.config'),
  PRELOAD_FILE: path.join(APP_SRC_DIR, 'preload', 'index.js'),
  RENDERER_HTML: path.join(APP_SRC_DIR, 'renderer', 'index.html'),
};
