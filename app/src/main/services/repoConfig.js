const fs = require('node:fs/promises');
const { APP_ENV_FILE } = require('../paths');

/**
 * Manager understand 時要決定開發的 repository。
 * 每個 repository 可選的 feature branch 由 app/.env 的 `<KEY>_BRANCHES` 設定（逗號分隔）。
 */
const REPOS = [
  { key: 'crmapp', label: 'crmapp', envKey: 'CRMAPP_BRANCHES' },
  { key: 'crmappui', label: 'crmappui', envKey: 'CRMAPPUI_BRANCHES' },
  { key: 'upagent', label: 'upagent', envKey: 'UPAGENT_BRANCHES' },
];

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
  return {
    envFound: Object.keys(env).length > 0,
    repos: REPOS.map(({ key, label, envKey }) => ({
      key,
      label,
      envKey,
      branches: splitList(env[envKey] ?? process.env[envKey]),
    })),
  };
}

module.exports = { REPOS, loadRepoConfig };
