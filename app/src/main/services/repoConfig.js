const fs = require('node:fs/promises');
const { REPOS_FILE } = require('../paths');

/**
 * Repository 設定統一放在 data/repos.json（不進 git，可由「匯出 / 匯入本地資料」帶到別台電腦；
 * 範本為 app/repos_example.json）。每次使用都重新讀取，修改後不用重開 App：
 *   { "repos": [{
 *       "key": "crmapp", "label": "crmapp", "color": "#2f6feb",
 *       "path": "C:\\source\\crmapp",
 *       "branches": ["feature/xxx"],
 *       "testBranch": "test", "prodBranch": "master",
 *       "testPipeline": "", "prodPipeline": ""
 *   }, ...] }
 *   - key：存進流程狀態（data/requirement_flow_state.json）的識別名稱，改名會讓既有紀錄對不上
 *   - label：畫面顯示名稱（預設 = key）；color：代表色（任何 CSS 顏色，選填）
 *   - path：本機 clone 的路徑（Confirm Commit 確認 commit、merge / push 用）
 *   - branches：規劃 時可選的 feature branch（陣列，也接受逗號分隔字串）
 *   - testBranch / prodBranch：環境 branch（勾 SaaS / Local 前確認 commit 已進到該 branch）
 *   - testPipeline / prodPipeline：環境 branch push 後自動佈版的 Pipeline 名稱（可寫「資料夾\名稱」；空白 = 沒有自動佈版）
 */
const FILE_LABEL = 'data/repos.json';
const KEY_RE = /^[A-Za-z0-9_.-]+$/;

/** 佈版階段 → data/repos.json 的欄位名稱 */
const DEPLOY_BRANCH_FIELDS = { testDeploy: 'testBranch', prodDeploy: 'prodBranch' };
const PIPELINE_FIELDS = { testDeploy: 'testPipeline', prodDeploy: 'prodPipeline' };

/** 錯誤訊息用：指出要去哪裡設定 */
const fieldHint = (key, field) => `${FILE_LABEL} 中 ${key} 的 "${field}"`;

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const list = (v) => [...new Set((Array.isArray(v) ? v : String(v || '').split(',')).map(str).filter(Boolean))];

/** 每次呼叫都重新讀取 data/repos.json，回傳 { repos: [{ key, label, color, path, branches, deployBranches, pipelines }] } */
async function loadRepoConfig() {
  let text;
  try {
    text = await fs.readFile(REPOS_FILE, 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error(`找不到 ${FILE_LABEL}（可複製 app/repos_example.json 為 ${FILE_LABEL} 後設定各 repository）`);
    throw err;
  }
  let data;
  try {
    data = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (err) {
    throw new Error(`${FILE_LABEL} 格式錯誤：${err.message}`);
  }
  const repos = Array.isArray(data) ? data : data?.repos;
  if (!Array.isArray(repos)) throw new Error(`${FILE_LABEL} 需要 "repos" 陣列`);
  const seen = new Set();
  const pick = (r, fields) => Object.fromEntries(Object.entries(fields).map(([stage, f]) => [stage, str(r[f])]));
  return {
    repos: repos.map((r, i) => {
      const key = str(r?.key);
      if (!KEY_RE.test(key)) throw new Error(`${FILE_LABEL} 第 ${i + 1} 個 repository 的 key 不正確（只能用英數字與 _ . -）`);
      if (seen.has(key)) throw new Error(`${FILE_LABEL} 的 key 重複：${key}`);
      seen.add(key);
      return {
        key,
        label: str(r.label) || key,
        color: str(r.color),
        path: str(r.path),
        branches: list(r.branches),
        deployBranches: pick(r, DEPLOY_BRANCH_FIELDS),
        pipelines: pick(r, PIPELINE_FIELDS),
      };
    }),
  };
}

module.exports = { loadRepoConfig, fieldHint, DEPLOY_BRANCH_FIELDS };
