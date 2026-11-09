const path = require('node:path');

// app/src/main → 專案根目錄
const ROOT_DIR = path.resolve(__dirname, '..', '..', '..');
const APP_SRC_DIR = path.resolve(__dirname, '..');

module.exports = {
  ROOT_DIR,
  DATA_DIR: path.join(ROOT_DIR, 'data'),
  SCRIPT_DIR: path.join(ROOT_DIR, 'script'),
  SHELL_DIR: path.join(ROOT_DIR, 'shell'),
  ITERATIONS_FILE: path.join(ROOT_DIR, 'data', 'iterations.json'),
  FLOW_STATE_FILE: path.join(ROOT_DIR, 'data', 'requirement_flow_state.json'),
  TEST_RECORDS_DIR: path.join(ROOT_DIR, 'data', 'test_records'),
  // 本機設定（見 services/appConfig.js）
  CONFIG_FILE: path.join(ROOT_DIR, 'data', 'config.json'),
  ENV_FILE: path.join(ROOT_DIR, 'data', '.env'),
  // 舊版設定檔：啟動時自動轉換到 CONFIG_FILE / ENV_FILE
  LEGACY_ENV_FILE: path.join(ROOT_DIR, 'script', '.env'),
  LEGACY_REPOS_FILE: path.join(ROOT_DIR, 'data', 'repos.json'),
  LEGACY_UPAGENT_CONFIG_FILE: path.join(ROOT_DIR, 'data', 'upagent_release.config'),
  PRELOAD_FILE: path.join(APP_SRC_DIR, 'preload', 'index.js'),
  RENDERER_HTML: path.join(APP_SRC_DIR, 'renderer', 'index.html'),
};
