import { api } from './api.js';
import { el } from './dom.js';

/**
 * Repository 顯示資訊（名稱 / 代表色）的快取，來源是 data/config.json 的 repos（經 repos:config 讀取）。
 * 流程表載入或 規劃 dialog 開啟時會重新讀取；不在設定檔中的 key 直接顯示 key、不上色。
 */
let byKey = new Map();

export function setRepoConfig(config) {
  byKey = new Map((config?.repos || []).map((r) => [r.key, r]));
}

export async function loadRepos() {
  const config = await api.loadRepoConfig();
  setRepoConfig(config);
  return config;
}

/** repository 名稱標籤（帶代表色；CSP 不允許 inline style 屬性，以 CSSOM 設定 CSS 變數） */
export function repoTag(key, cls = 'repo-name') {
  const r = byKey.get(key);
  const tag = el('span', `${cls} repo-tag`, r?.label || key);
  if (r?.color) {
    tag.classList.add('has-color');
    tag.style.setProperty('--repo-color', r.color);
  }
  return tag;
}

/** repository 的顯示名稱（錯誤訊息等純文字用） */
export const repoLabel = (key) => byKey.get(key)?.label || key;
