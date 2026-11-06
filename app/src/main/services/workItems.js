const { runScriptJson } = require('../python');

/** 執行 get_iteration_work_items.py 抓取指定 Iteration 的 Work Item。 */
async function fetchWorkItems({ iterationPath, exact } = {}) {
  if (typeof iterationPath !== 'string' || !iterationPath) throw new Error('缺少 iterationPath');
  const args = ['--iteration', iterationPath];
  if (exact) args.push('--exact');
  return runScriptJson('get_iteration_work_items.py', args);
}

module.exports = { fetchWorkItems };
