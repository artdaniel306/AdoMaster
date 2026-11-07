const path = require('node:path');

// app/src/main → 專案根目錄
const ROOT_DIR = path.resolve(__dirname, '..', '..', '..');
const APP_SRC_DIR = path.resolve(__dirname, '..');

module.exports = {
  ROOT_DIR,
  DATA_DIR: path.join(ROOT_DIR, 'data'),
  SCRIPT_DIR: path.join(ROOT_DIR, 'script'),
  ITERATIONS_FILE: path.join(ROOT_DIR, 'data', 'iterations.json'),
  FLOW_STATE_FILE: path.join(ROOT_DIR, 'data', 'requirement_flow_state.json'),
  REPOS_FILE: path.join(ROOT_DIR, 'data', 'repos.json'),
  PRELOAD_FILE: path.join(APP_SRC_DIR, 'preload', 'index.js'),
  RENDERER_HTML: path.join(APP_SRC_DIR, 'renderer', 'index.html'),
};
