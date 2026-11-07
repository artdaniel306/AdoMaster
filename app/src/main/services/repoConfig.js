const fs = require('node:fs/promises');
const { APP_ENV_FILE, REPOS_FILE } = require('../paths');

/**
 * 規劃 時可選擇開發的 repository 清單定義在 app/repos.json（每次讀取，修改後不用重開 App）：
 *   { "repos": [{ "key": "crmapp", "label": "crmapp", "color": "#2f6feb", "envPrefix": "CRMAPP" }, ...] }
 *   - key：存進流程狀態（data/requirement_flow_state.json）的識別名稱，改名會讓既有紀錄對不上
 *   - label：畫面顯示名稱（預設 = key）；color：代表色（任何 CSS 顏色，選填）
 *   - envPrefix：app/.env 設定的前綴（預設 = key 轉大寫，非英數字轉成 _）
 * 各 repository 與本機 / 環境相關的設定仍放在 app/.env：
 *   可選的 feature branch：`<PREFIX>_BRANCHES`（逗號分隔）；本機 clone 路徑：`<PREFIX>_REPO_PATH`（Confirm Commit 確認 commit 用）；
 *   環境 branch：`<PREFIX>_TEST_BRANCH` / `<PREFIX>_PROD_BRANCH`（勾 SaaS / Local 前確認 commit 已進到該 branch）；
 *   自動佈版 Pipeline：`<PREFIX>_TEST_PIPELINE` / `<PREFIX>_PROD_PIPELINE`（未設定 = 沒有自動佈版）。
 */
const KEY_RE = /^[A-Za-z0-9_.-]+$/;

/** 讀取並驗證 app/repos.json，回傳 [{ key, label, color, prefix }] */
async function readRepoList() {
  let text;
  try {
    text = await fs.readFile(REPOS_FILE, 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error('找不到 app/repos.json（repository 清單設定檔）');
    throw err;
  }
  let data;
  try {
    data = JSON.parse(text.replace(/^﻿/, ''));
  } catch (err) {
    throw new Error(`app/repos.json 格式錯誤：${err.message}`);
  }
  const list = Array.isArray(data) ? data : data?.repos;
  if (!Array.isArray(list)) throw new Error('app/repos.json 需要 "repos" 陣列');
  const seen = new Set();
  return list.map((r, i) => {
    const key = typeof r?.key === 'string' ? r.key.trim() : '';
    if (!KEY_RE.test(key)) throw new Error(`app/repos.json 第 ${i + 1} 個 repository 的 key 不正確（只能用英數字與 _ . -）`);
    if (seen.has(key)) throw new Error(`app/repos.json 的 key 重複：${key}`);
    seen.add(key);
    const str = (v) => (typeof v === 'string' ? v.trim() : '');
    return {
      key,
      label: str(r.label) || key,
      color: str(r.color),
      prefix: (str(r.envPrefix) || key.replace(/[^A-Za-z0-9]/g, '_')).toUpperCase(),
    };
  });
}

/** 簡易 .env 解析（與 script/ado/config.py 相同規則）：KEY=VALUE，支援 # 註解與引號。檔案不存在時回傳 {}。 */
async function readEnv(file) {
  let text;
  try {
    text = await fs.readFile(file, 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
  const env = {};
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const i = line.indexOf('=');
    let key = line.slice(0, i).trim();
    if (key.startsWith('export ')) key = key.slice(7).trim();
    let value = line.slice(i + 1).trim();
    if (!["'", '"'].includes(value[0])) value = value.split(' #')[0].trim(); // 未加引號時去除行尾註解
    if (value.length >= 2 && value[0] === value.at(-1) && ["'", '"'].includes(value[0])) value = value.slice(1, -1);
    env[key] = value;
  }
  return env;
}

const splitList = (v) => [...new Set(String(v || '').split(',').map((s) => s.trim()).filter(Boolean))];

/** 每次呼叫都重新讀取 app/repos.json 與 app/.env，修改設定後不用重開 App。 */
async function loadRepoConfig() {
  const [list, env] = await Promise.all([readRepoList(), readEnv(APP_ENV_FILE)]);
  const get = (k) => String(env[k] ?? process.env[k] ?? '').trim();
  return {
    envFound: Object.keys(env).length > 0,
    repos: list.map(({ key, label, color, prefix }) => {
      const envKey = `${prefix}_BRANCHES`;
      const pathEnvKey = `${prefix}_REPO_PATH`;
      // 佈版階段 → 環境 branch / 自動佈版 Pipeline 的設定名稱
      const deployEnvKeys = { testDeploy: `${prefix}_TEST_BRANCH`, prodDeploy: `${prefix}_PROD_BRANCH` };
      const pipelineEnvKeys = { testDeploy: `${prefix}_TEST_PIPELINE`, prodDeploy: `${prefix}_PROD_PIPELINE` };
      const pick = (keys) => Object.fromEntries(Object.entries(keys).map(([stage, k]) => [stage, get(k)]));
      return {
        key,
        label,
        color,
        envKey,
        pathEnvKey,
        deployEnvKeys,
        branches: splitList(get(envKey)),
        path: get(pathEnvKey),
        deployBranches: pick(deployEnvKeys),
        pipelineEnvKeys,
        pipelines: pick(pipelineEnvKeys),
      };
    }),
  };
}

module.exports = { loadRepoConfig };
