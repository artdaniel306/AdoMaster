const fs = require('node:fs/promises');
const { FLOW_STATE_FILE } = require('../paths');
const { writeFileAtomic } = require('../atomicWrite');
const { PLAN_KEY, PLAN_REPOS_KEY, PLAN_MIGRATION_KEY, PLAN_NOTE_KEY } = require('../../shared/flow-rules.js');

/**
 * Requirement 流程的本機狀態檔（規劃、佈版、測試、發表會…的勾選與記錄）：
 * data/requirement_flow_state.json → { "<requirementId>": { "<checkKey>": true, ... } }
 * 所有寫入都排進同一個 writeQueue（序列化讀改寫），各 service 只透過這裡讀寫。
 */

/** 舊版（「Manager understand」時期）存的 key → 現在的 key */
const LEGACY_KEYS = {
  understand: PLAN_KEY,
  understandRepos: PLAN_REPOS_KEY,
  understandMigration: PLAN_MIGRATION_KEY,
  understandNote: PLAN_NOTE_KEY,
};

/** 讀檔時把舊 key 轉成新 key（下次寫入時就會以新 key 存回；匯入舊版匯出的檔案也適用） */
function migrateLegacyKeys(state) {
  for (const checks of Object.values(state || {})) {
    if (!checks || typeof checks !== 'object') continue;
    for (const [oldKey, newKey] of Object.entries(LEGACY_KEYS)) {
      if (!(oldKey in checks)) continue;
      if (!(newKey in checks)) checks[newKey] = checks[oldKey];
      delete checks[oldKey];
    }
  }
  return state;
}

const stripBom = (text) => text.replace(/^﻿/, '');

/** 讀出整份流程狀態（檔案不存在時回傳 {}） */
async function loadFlowState() {
  try {
    return migrateLegacyKeys(JSON.parse(stripBom(await fs.readFile(FLOW_STATE_FILE, 'utf-8'))));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

let writeQueue = Promise.resolve(); // 序列化讀改寫，避免連續勾選時互相覆蓋

/** 讀出某個 Requirement 的狀態交給 mutate 修改後寫回，回傳該 Requirement 更新後的狀態。 */
function updateRequirementState(id, mutate) {
  const task = writeQueue.then(async () => {
    const state = await loadFlowState();
    const checks = { ...(state[id] || {}) };
    mutate(checks);
    if (Object.keys(checks).length) state[id] = checks;
    else delete state[id];
    await writeFileAtomic(FLOW_STATE_FILE, JSON.stringify(state, null, 2));
    return checks;
  });
  writeQueue = task.catch(() => {});
  return task;
}

/**
 * 讀出整份流程狀態交給 mutate 直接修改後寫回（一次更新多個 Requirement 時用，例如同一個 UpAgent 版本的資料庫寫入紀錄）。
 * 同樣排進 writeQueue；回傳更新後的整份狀態。
 */
function updateFlowState(mutate) {
  const task = writeQueue.then(async () => {
    const state = await loadFlowState();
    mutate(state);
    await writeFileAtomic(FLOW_STATE_FILE, JSON.stringify(state, null, 2));
    return state;
  });
  writeQueue = task.catch(() => {});
  return task;
}

/** 整份覆蓋流程狀態檔（匯入本地資料用）；同樣排進 writeQueue，不會和勾選的寫入互相覆蓋。 */
function replaceFlowState(text) {
  const clean = stripBom(text);
  JSON.parse(clean); // 不是合法 JSON 就直接丟錯，不寫入
  const task = writeQueue.then(() => writeFileAtomic(FLOW_STATE_FILE, clean));
  writeQueue = task.catch(() => {});
  return task;
}

module.exports = { loadFlowState, updateRequirementState, updateFlowState, replaceFlowState };
