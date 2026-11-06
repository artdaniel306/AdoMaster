/**
 * Requirement 流程的共用規則：main process（require）與 renderer（import）共用同一份，避免兩邊判斷不一致。
 * 只能放純資料與純函式（不可使用 Node / DOM API）。
 *
 * data/requirement_flow_state.json 中每個 Requirement 的 checks：
 *   understand: true                       Manager understand 已確認
 *   understandRepos: { repoKey: branch }   要開發的 repository 與 feature branch
 *   understandMigration: true              需要 migration
 *   understandNote: '...'                  manager 註解
 *   <stage>.commits: { repoKey: commit }   Confirm Commit 的 commit
 *   <stage>.commitsForced: true            跳階段直接勾起 Confirm Commit（沒有實際填 commit）
 *   <checkKey>: true                       其他 checkbox（SaaS / Local、測試完成…）
 */

export const UNDERSTAND_KEY = 'understand';
export const UNDERSTAND_REPOS_KEY = 'understandRepos';
export const UNDERSTAND_MIGRATION_KEY = 'understandMigration';
export const UNDERSTAND_NOTE_KEY = 'understandNote';
export const UNDERSTAND_KEYS = [UNDERSTAND_KEY, UNDERSTAND_REPOS_KEY, UNDERSTAND_MIGRATION_KEY, UNDERSTAND_NOTE_KEY];

/** 佈版前要先 Confirm Commit 的階段 */
export const COMMIT_STAGES = ['testDeploy', 'prodDeploy'];
export const isCommitStage = (stage) => COMMIT_STAGES.includes(stage);
export const commitsKey = (stage) => `${stage}.commits`;
export const commitsForcedKey = (stage) => `${stage}.commitsForced`;

/** commit 縮寫：4～40 個十六進位字元（也避免被 git 當成選項）；比對前先轉小寫 */
export const COMMIT_RE = /^[0-9a-f]{4,40}$/;
export const COMMIT_FORMAT_HINT = '需為 4～40 碼的十六進位 hash';

/** 已確認的 commit 是否涵蓋 Manager understand 選的每個 repository */
export function commitsCover(checks, stage) {
  const commits = checks[commitsKey(stage)] || {};
  return Object.keys(checks[UNDERSTAND_REPOS_KEY] || {}).every((r) => commits[r]);
}

/**
 * Confirm Commit 是否已完成：commit 涵蓋所有 repository，或跳階段直接勾起。
 * Manager understand 沒選任何 repository（例如只需調整 database 資料）時，視為自動完成。
 */
export function commitsConfirmed(checks, stage) {
  return !!checks[commitsForcedKey(stage)] || (!!checks[UNDERSTAND_KEY] && commitsCover(checks, stage));
}
