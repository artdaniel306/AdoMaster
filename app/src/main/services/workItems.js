const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { runScript } = require('../python');

/** 執行 get_iteration_work_items.py 抓取指定 Iteration 的 Work Item。 */
async function fetchWorkItems({ iterationPath, exact } = {}) {
  if (typeof iterationPath !== 'string' || !iterationPath) throw new Error('缺少 iterationPath');
  // 每次請求用獨立暫存檔，避免同時查詢互相覆寫
  const out = path.join(
    os.tmpdir(),
    `ado-master-wi-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
  );
  const args = ['--iteration', iterationPath, '--out', out];
  if (exact) args.push('--exact');
  try {
    await runScript('get_iteration_work_items.py', args);
    return JSON.parse(await fs.readFile(out, 'utf-8'));
  } finally {
    fs.rm(out, { force: true }).catch(() => {});
  }
}

module.exports = { fetchWorkItems };
