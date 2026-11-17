const { runScriptJson } = require('../python');

/** 執行 get_iteration_work_items.py 抓取指定 Iteration 的 Work Item。 */
async function fetchWorkItems({ iterationPath, exact } = {}) {
  if (typeof iterationPath !== 'string' || !iterationPath) throw new Error('缺少 iterationPath');
  const args = ['--iteration', iterationPath];
  if (exact) args.push('--exact');
  return runScriptJson('get_iteration_work_items.py', args);
}

/** 執行 get_comments.py 抓取 Work Item 最新的 top 筆留言（新 → 舊）。 */
async function fetchComments({ id, top = 3 } = {}) {
  if (!Number.isInteger(id) || id <= 0) throw new Error('Work Item id 不正確');
  if (!Number.isInteger(top) || top <= 0) throw new Error('留言筆數不正確');
  return runScriptJson('get_comments.py', ['--id', String(id), '--top', String(top)]);
}

module.exports = { fetchWorkItems, fetchComments };
