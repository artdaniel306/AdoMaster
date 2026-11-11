const path = require('node:path');

/**
 * 以本機資料夾為 key 的排隊鎖：同一個 clone 的 git 操作（git.js 的每個 git 指令、Sync-Repos.ps1、Deploy-Local.ps1）依序執行，
 * 避免同時 fetch / push 造成 ref lock 失敗，或同步快轉 branch 時改到正在 build 的 working tree。
 * 一次取得多個路徑的鎖時是同步登記到每個路徑的佇列尾端，所以排隊順序全域一致，不會互相等待（deadlock）。
 * 注意：持有鎖的 fn 裡不可再對同一路徑取鎖（會等自己）。
 */

/** key → 目前排在最後的持有者結束時 resolve 的 Promise（永不 reject） */
const tails = new Map();

const keyOf = (p) => {
  const r = path.resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
};

function waitFor(promises, signal) {
  const all = Promise.all(promises);
  if (!signal) return all;
  if (signal.aborted) return Promise.reject(new Error('已停止'));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new Error('已停止'));
    signal.addEventListener('abort', onAbort, { once: true });
    all.then(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    });
  });
}

/**
 * 取得 paths 的鎖後執行 fn，結束（成功 / 失敗）後釋放。
 * @param signal 等待中被中止時丟出「已停止」（不影響排在後面的人：他們仍會等前面的持有者結束）
 * @param onWait 需要等待時先呼叫一次（例如在 log 顯示「等待中」）
 */
async function withPathLock(paths, fn, { signal, onWait } = {}) {
  const keys = [...new Set(paths.filter(Boolean).map(keyOf))];
  const prev = [...new Set(keys.map((k) => tails.get(k)).filter(Boolean))];
  let finish;
  const finished = new Promise((resolve) => {
    finish = resolve;
  });
  // 後面的人要等「前面的持有者」與「自己」都結束（自己等待中被中止時，前面的仍可能在執行）
  const done = Promise.all([...prev, finished]).then(() => {});
  for (const k of keys) tails.set(k, done);
  try {
    if (prev.length) {
      onWait?.();
      await waitFor(prev, signal);
    }
    return await fn();
  } finally {
    finish();
    done.then(() => {
      for (const k of keys) if (tails.get(k) === done) tails.delete(k);
    });
  }
}

module.exports = { withPathLock };
