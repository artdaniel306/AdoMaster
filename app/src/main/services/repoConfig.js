const fs = require('node:fs/promises');
const path = require('node:path');
const { dialog } = require('electron');
const { REPOS_FILE } = require('../paths');

/**
 * Repository 設定統一放在 data/repos.json（不進 git，可由「匯出 / 匯入本地資料」帶到別台電腦；
 * 範本為 app/repos_example.json）。每次使用都重新讀取，修改後不用重開 App：
 *   { "repos": [{
 *       "key": "crmapp", "label": "crmapp", "color": "#2f6feb",
 *       "path": "C:\\source\\crmapp",
 *       "branches": ["feature/xxx"],
 *       "testBranch": "test", "prodBranch": "master",
 *       "testPipeline": "", "prodPipeline": "",
 *       "testAppService": "", "testResourceGroup": ""
 *   }, ...] }
 *   - key：存進流程狀態（data/requirement_flow_state.json）的識別名稱，改名會讓既有紀錄對不上
 *   - label：畫面顯示名稱（預設 = key）；color：代表色（任何 CSS 顏色，選填）
 *   - path：本機 clone 的路徑（Confirm Commit 確認 commit、merge / push 用）
 *   - branches：規劃 時可選的 feature branch（陣列，也接受逗號分隔字串）
 *   - testBranch / prodBranch：環境 branch（勾 SaaS / Local 前確認 commit 已進到該 branch）
 *   - testPipeline / prodPipeline：環境 branch push 後自動佈版的 Pipeline 名稱（可寫「資料夾\名稱」；空白 = 沒有自動佈版）
 *   - testAppService / testResourceGroup：測試環境 Pipeline Run 成功後要重啟的 App Service（afterDeploy.js；
 *     空白 = 不重啟；Resource Group 空白時自動查詢）。正式環境刻意沒有對應欄位（不自動重啟）
 */
const FILE_LABEL = 'data/repos.json';
const KEY_RE = /^[A-Za-z0-9_.-]+$/;

/** 佈版階段 → data/repos.json 的欄位名稱 */
const DEPLOY_BRANCH_FIELDS = { testDeploy: 'testBranch', prodDeploy: 'prodBranch' };
const PIPELINE_FIELDS = { testDeploy: 'testPipeline', prodDeploy: 'prodPipeline' };
/** 佈版後要重啟的 App Service：只有測試環境（正式環境有客戶在用，不自動重啟） */
const APP_SERVICE_FIELDS = { testDeploy: { name: 'testAppService', resourceGroup: 'testResourceGroup' } };

/** 錯誤訊息用：指出要去哪裡設定 */
const fieldHint = (key, field) => `${FILE_LABEL} 中 ${key} 的 "${field}"`;

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const list = (v) => [...new Set((Array.isArray(v) ? v : String(v || '').split(/[,\r\n]/)).map(str).filter(Boolean))];

/** 讀取並解析 data/repos.json，回傳原始的 repos 陣列；檔案不存在且 missingOk 時回傳 null */
async function readRepoFile({ missingOk = false } = {}) {
  let text;
  try {
    text = await fs.readFile(REPOS_FILE, 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      if (missingOk) return null;
      throw new Error(`找不到 ${FILE_LABEL}（可從選單「設定 → Repository 設定…」建立，或複製 app/repos_example.json 為 ${FILE_LABEL}）`);
    }
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
  return repos;
}

/** 每次呼叫都重新讀取 data/repos.json，回傳 { repos: [{ key, label, color, path, branches, deployBranches, pipelines, appServices }] } */
async function loadRepoConfig() {
  return { repos: normalizeRepos(await readRepoFile()) };
}

/** 檢查 key（格式、重複）並整理成 App 使用的結構 */
function normalizeRepos(repos) {
  const seen = new Set();
  const pick = (r, fields) => Object.fromEntries(Object.entries(fields).map(([stage, f]) => [stage, str(r[f])]));
  return repos.map((r, i) => {
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
      appServices: Object.fromEntries(
        Object.entries(APP_SERVICE_FIELDS).map(([stage, f]) => [stage, { name: str(r[f.name]), resourceGroup: str(r[f.resourceGroup]) }])
      ),
    };
  });
}

/** 設定 dialog 編輯的欄位（其餘欄位原樣保留） */
const EDIT_FIELDS = ['key', 'label', 'color', 'path', 'branches', 'testBranch', 'prodBranch', 'testPipeline', 'prodPipeline', 'testAppService', 'testResourceGroup'];

/**
 * 給「Repository 設定」dialog 用：回傳 data/repos.json 的原始內容（branches 一律轉成陣列）。
 * @returns {Promise<{ exists: boolean, repos: object[] }>}
 */
async function loadRepoSettings() {
  const repos = await readRepoFile({ missingOk: true });
  if (!repos) return { exists: false, repos: [] };
  return {
    exists: true,
    repos: repos.map((r) => ({
      ...Object.fromEntries(EDIT_FIELDS.map((f) => [f, str(r?.[f])])),
      branches: list(r?.branches),
      origKey: str(r?.key),
    })),
  };
}

/**
 * 儲存「Repository 設定」dialog 的內容到 data/repos.json（暫存檔 + rename）。
 * 以原本的 key（origKey）對回檔案中的原始物件，保留 dialog 沒編輯的額外欄位；檔案頂層的其他欄位也保留。
 * @param repos [{ origKey?, key, label, color, path, branches: string[] | string, testBranch, ... }]
 */
async function saveRepoSettings({ repos } = {}) {
  if (!Array.isArray(repos)) throw new Error('repos 必須是陣列');
  let original = [];
  let top = {};
  try {
    const text = await fs.readFile(REPOS_FILE, 'utf-8');
    const data = JSON.parse(text.replace(/^﻿/, ''));
    if (Array.isArray(data)) original = data;
    else if (data && typeof data === 'object') {
      top = data;
      if (Array.isArray(data.repos)) original = data.repos;
    }
  } catch { /* 不存在或格式錯誤：直接以 dialog 的內容覆寫 */ }
  const byKey = new Map(original.filter((r) => r && typeof r === 'object').map((r) => [str(r.key), r]));

  const out = repos.map((r) => {
    const base = byKey.get(str(r?.origKey)) || {};
    const entry = { ...base };
    for (const f of EDIT_FIELDS) entry[f] = f === 'branches' ? list(r?.branches) : str(r?.[f]);
    return entry;
  });
  normalizeRepos(out); // key 格式 / 重複檢查，失敗時丟出錯誤、不寫檔

  // requirementFlow 本身會 require 這個模組，延後到這裡才載入以避免循環相依
  const { writeFileAtomic } = require('./requirementFlow');
  await fs.mkdir(path.dirname(REPOS_FILE), { recursive: true });
  await writeFileAtomic(REPOS_FILE, `${JSON.stringify({ ...top, repos: out }, null, 2)}
`);
  return { repos: normalizeRepos(out) };
}

/** 讓使用者選擇本機 clone 的資料夾；取消時回傳 null */
async function pickRepoFolder(win, defaultPath) {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: '選擇 repository 的本機資料夾',
    defaultPath: str(defaultPath) || undefined,
    properties: ['openDirectory'],
  });
  return canceled || !filePaths?.length ? null : filePaths[0];
}

module.exports = { loadRepoConfig, loadRepoSettings, saveRepoSettings, pickRepoFolder, fieldHint, DEPLOY_BRANCH_FIELDS };
