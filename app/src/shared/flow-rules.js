/**
 * Requirement 流程的共用規則：main process（require）與 renderer（import）共用同一份，避免兩邊判斷不一致。
 * 只能放純資料與純函式（不可使用 Node / DOM API）。
 *
 * data/requirement_flow_state.json 中每個 Requirement 的 checks：
 *   plan: true                             規劃已確認
 *   planRepos: { repoKey: branch }         要開發的 repository 與 feature branch
 *   planMigration: true                    需要 migration
 *   planNote: '...'                        manager 註解
 *   <stage>.commits: { repoKey: commit }   Confirm Commit 的 commit
 *   <stage>.commitsForced: true            跳階段直接勾起 Confirm Commit（沒有實際填 commit）
 *   testRecord: { note, images, updatedAt } 測試完成時記錄的測試場景（images 為 data/test_records/<id>/ 下的檔名）
 *   <checkKey>: true                       其他 checkbox（SaaS / Local、測試完成…）
 */

export const PLAN_KEY = 'plan';
export const PLAN_REPOS_KEY = 'planRepos';
export const PLAN_MIGRATION_KEY = 'planMigration';
export const PLAN_NOTE_KEY = 'planNote';
export const PLAN_KEYS = [PLAN_KEY, PLAN_REPOS_KEY, PLAN_MIGRATION_KEY, PLAN_NOTE_KEY];

/** 測試完成的 checkbox 與測試場景記錄 */
export const TEST_KEY = 'test';
export const TEST_RECORD_KEY = 'testRecord';
/** 測試記錄圖片的檔名（只允許這種格式，避免路徑穿越） */
export const TEST_IMAGE_RE = /^[\w-]+\.(png|jpe?g|gif|webp|bmp)$/i;

/** 佈版前要先 Confirm Commit 的階段 */
export const COMMIT_STAGES = ['testDeploy', 'prodDeploy'];
export const isCommitStage = (stage) => COMMIT_STAGES.includes(stage);
export const commitsKey = (stage) => `${stage}.commits`;
export const commitsForcedKey = (stage) => `${stage}.commitsForced`;

/** commit 縮寫：4～40 個十六進位字元（也避免被 git 當成選項）；比對前先轉小寫 */
export const COMMIT_RE = /^[0-9a-f]{4,40}$/;
export const COMMIT_FORMAT_HINT = '需為 4～40 碼的十六進位 hash';

/** 已確認的 commit 是否涵蓋 規劃 選的每個 repository */
export function commitsCover(checks, stage) {
  const commits = checks[commitsKey(stage)] || {};
  return Object.keys(checks[PLAN_REPOS_KEY] || {}).every((r) => commits[r]);
}

/**
 * 規劃 已確認且沒選任何 repository（不需修改 repository，例如只需調整 database 資料）：
 * Confirm Commit 自動完成，佈版階段的 SaaS / Local 也省略（不需勾選即視為完成）。
 */
export function noRepoChange(checks) {
  return !!checks[PLAN_KEY] && !Object.keys(checks[PLAN_REPOS_KEY] || {}).length;
}

/**
 * Confirm Commit 是否已完成：commit 涵蓋所有 repository，或跳階段直接勾起。
 * 規劃 沒選任何 repository（例如只需調整 database 資料）時，視為自動完成。
 */
export function commitsConfirmed(checks, stage) {
  return !!checks[commitsForcedKey(stage)] || (!!checks[PLAN_KEY] && commitsCover(checks, stage));
}
