const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { FLOW_STATE_FILE } = require('../paths');
const { runScript } = require('../python');

/** 執行 get_requirement_flow.py 取得指定 Iteration 的 Requirement 與其子項目。 */
async function fetchRequirementFlow({ iterationPath, exact } = {}) {
  if (typeof iterationPath !== 'string' || !iterationPath) throw new Error('缺少 iterationPath');
  // 每次請求用獨立暫存檔，避免同時查詢互相覆寫
  const out = path.join(
    os.tmpdir(),
    `ado-master-flow-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
  );
  const args = ['--iteration', iterationPath, '--out', out];
  if (exact) args.push('--exact');
  try {
    await runScript('get_requirement_flow.py', args);
    return JSON.parse(await fs.readFile(out, 'utf-8'));
  } finally {
    fs.rm(out, { force: true }).catch(() => {});
  }
}

/**
 * 流程中尚未串接 ADO 的人工步驟（Manager understand、佈版、測試、發表會…）先以 checkbox 記錄在本機：
 * data/requirement_flow_state.json → { "<requirementId>": { "<checkKey>": true, ... } }
 */
async function loadFlowState() {
  try {
    return JSON.parse(await fs.readFile(FLOW_STATE_FILE, 'utf-8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

let writeQueue = Promise.resolve(); // 序列化讀改寫，避免連續勾選時互相覆蓋

/** 設定某個 Requirement 的一個 checkbox，回傳該 Requirement 更新後的狀態。 */
function setFlowCheck({ id, key, value } = {}) {
  if (!Number.isInteger(id) || typeof key !== 'string' || !/^[\w.]+$/.test(key)) {
    return Promise.reject(new Error('參數錯誤'));
  }
  const task = writeQueue.then(async () => {
    const state = await loadFlowState();
    const checks = { ...(state[id] || {}) };
    if (value) checks[key] = true;
    else delete checks[key];
    if (Object.keys(checks).length) state[id] = checks;
    else delete state[id];
    await fs.mkdir(path.dirname(FLOW_STATE_FILE), { recursive: true });
    await fs.writeFile(FLOW_STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
    return checks;
  });
  writeQueue = task.catch(() => {});
  return task;
}

module.exports = { fetchRequirementFlow, loadFlowState, setFlowCheck };
