const fs = require('node:fs/promises');
const { APP_ENV_FILE } = require('../paths');

/**
 * Manager understand 時要決定開發的 repository。
 * 每個 repository 可選的 feature branch 由 app/.env 的 `<KEY>_BRANCHES` 設定（逗號分隔），
 * Confirm Commit 時到 `<KEY>_REPO_PATH`（本機 clone 的路徑）確認 commit 是否存在。
 * Test deploy / Prod deploy 勾 SaaS / Local 前，確認 commit 已進到環境 branch：`<KEY>_TEST_BRANCH` / `<KEY>_PROD_BRANCH`。
 * 環境 branch push 後自動佈版的 Azure DevOps Pipeline 名稱：`<KEY>_TEST_PIPELINE` / `<KEY>_PROD_PIPELINE`（未設定 = 沒有自動佈版）。
 */
const REPOS = [
  { key: 'crmapp', label: 'crmapp', prefix: 'CRMAPP' },
  { key: 'crmappui', label: 'crmappui', prefix: 'CRMAPPUI' },
  { key: 'upagent', label: 'upagent', prefix: 'UPAGENT' },
].map(({ prefix, ...r }) => ({
  ...r,
  envKey: `${prefix}_BRANCHES`,
  pathEnvKey: `${prefix}_REPO_PATH`,
  // 佈版階段 → 環境 branch 的設定名稱
  deployEnvKeys: { testDeploy: `${prefix}_TEST_BRANCH`, prodDeploy: `${prefix}_PROD_BRANCH` },
  // 佈版階段 → 自動佈版 Pipeline 的設定名稱
  pipelineEnvKeys: { testDeploy: `${prefix}_TEST_PIPELINE`, prodDeploy: `${prefix}_PROD_PIPELINE` },
}));

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

/** 每次呼叫都重新讀取 app/.env，修改設定後不用重開 App。 */
async function loadRepoConfig() {
  const env = await readEnv(APP_ENV_FILE);
  const get = (k) => String(env[k] ?? process.env[k] ?? '').trim();
  return {
    envFound: Object.keys(env).length > 0,
    repos: REPOS.map(({ key, label, envKey, pathEnvKey, deployEnvKeys, pipelineEnvKeys }) => ({
      key,
      label,
      envKey,
      pathEnvKey,
      deployEnvKeys,
      branches: splitList(get(envKey)),
      path: get(pathEnvKey),
      deployBranches: Object.fromEntries(Object.entries(deployEnvKeys).map(([stage, k]) => [stage, get(k)])),
      pipelineEnvKeys,
      pipelines: Object.fromEntries(Object.entries(pipelineEnvKeys).map(([stage, k]) => [stage, get(k)])),
    })),
  };
}

module.exports = { REPOS, loadRepoConfig };
