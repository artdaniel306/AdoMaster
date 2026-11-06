const fs = require('node:fs/promises');
const { ITERATIONS_FILE } = require('../paths');
const { runScript } = require('../python');

/** 讀取 data/iterations.json（扁平清單，renderer 端組成樹狀）；檔案不存在時回傳 null。 */
async function loadIterations() {
  try {
    return JSON.parse(await fs.readFile(ITERATIONS_FILE, 'utf-8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/** 重新執行 get_iterations.py 同步 Iteration，再讀回。 */
async function syncIterations() {
  await runScript('get_iterations.py');
  return loadIterations();
}

module.exports = { loadIterations, syncIterations };
