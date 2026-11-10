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
 *   upagentRelease: { version, bump, remark, completed, publishedAt, db: { test_saas, test_local, prod_saas, prod_local } }
 *                                          UpAgent 發佈進度（completed = 最後完成的發佈步驟；db 為各環境 SaaS / Local 寫入資料庫的時間）
 *                                          adoptedFrom = 沿用的版本是哪張 Requirement 發佈的（Confirm Commit 已包含在已發佈的版本中，
 *                                          不再 Bump；db 會同步到同版本的所有紀錄。見 main/services/upagentRelease.js）
 *   <stage>.localDeploy: { repoKey: { forCommit, commit, image, tar, remoteHost, deployedAt } }
 *                                          勾 Local 時 Local 佈版（shell/Deploy-Local.ps1）成功的紀錄
 *                                          （forCommit = 當時的 Confirm Commit；commit = 實際 build 的環境 branch commit）
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

/** Local 佈版紀錄（勾 Local 時執行 shell/Deploy-Local.ps1；只能由 main/services/localDeploy.js 寫入） */
export const localDeployKey = (stage) => `${stage}.localDeploy`;
/** 佈版階段 → config.json 的 localDeploy.repos.<repo>.<test|prod> */
export const DEPLOY_ENV = { testDeploy: 'test', prodDeploy: 'prod' };

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

/**
 * UpAgent 發佈（shell/Release-UpAgent.ps1）：規劃選了 upagent 時，勾佈版階段的 SaaS / Local 會先執行。
 * Bump～CleanStaging 只需做一次（測試 / 正式環境共用 Blob 上的同一個版本），Database 則每個環境的 SaaS / Local 各寫一次
 * （4 個資料庫各自的連線）。
 */
export const UPAGENT_REPO = 'upagent';
export const UPAGENT_RELEASE_KEY = 'upagentRelease';
export const RELEASE_STEPS = ['Bump', 'WaitAction', 'Download', 'Sign', 'UpdateYml', 'Publish', 'CleanStaging', 'Database'];
export const RELEASE_ENV = { testDeploy: 'test', prodDeploy: 'prod' };
/** SaaS / Local 各有自己的資料庫：checkbox key 的後綴（<stage>.saas / <stage>.local） */
export const RELEASE_TARGETS = ['saas', 'local'];
/** 資料庫代號（upagentRelease.db 的 key；對應設定檔區段 [upagent_db_<代號>]） */
export const releaseDbKey = (env, target) => `${env}_${target}`;
export const RELEASE_DB_LABEL = {
  test_saas: '測試環境 SaaS',
  test_local: '測試環境 Local',
  prod_saas: '正式環境 SaaS',
  prod_local: '正式環境 Local',
};

/**
 * UpAgent 連線（測試 / 檢核階段，規劃含 upagent 時顯示）：本機 UpAgent 要連到哪個環境。
 * key = config.json upagentConnection.activationCodes 的 key。
 */
export const UPAGENT_CONNECTIONS = [
  { key: 'local_test', label: 'Local Test' },
  { key: 'local_prod', label: 'Local Prod' },
  { key: 'saas_test', label: 'SaaS Test' },
  { key: 'saas_prod', label: 'SaaS Prod' },
];

/** 佈版階段 checkbox key（testDeploy.saas…）對應的 target（saas / local）；不是 SaaS / Local 時回傳 null */
export function releaseTargetOf(key) {
  const target = key.slice(key.lastIndexOf('.') + 1);
  return RELEASE_TARGETS.includes(target) ? target : null;
}

/** 規劃的 repository 是否含 upagent */
export function needsUpagentRelease(checks) {
  return !!checks[PLAN_KEY] && Object.prototype.hasOwnProperty.call(checks[PLAN_REPOS_KEY] || {}, UPAGENT_REPO);
}

/**
 * 勾某個佈版階段的 SaaS / Local（target = 'saas' | 'local'）時，UpAgent 發佈要從哪一步開始：
 *   null              不需執行（規劃沒有 upagent，或此環境此 target 的資料庫已寫入）
 *   { startFrom: 'Bump' }                         尚未開始：完整發佈（需選 minor / patch）
 *   { startFrom: 'Sign', version }                上次中途失敗：從下一步接續
 *   { startFrom: 'Database', version }            已上傳過 Blob：只寫入此資料庫
 * 回傳的物件另含 env（test / prod）、target、db（資料庫代號，例如 test_saas）。
 */
export function upagentReleasePlan(checks, stage, target) {
  const env = RELEASE_ENV[stage];
  if (!env || !RELEASE_TARGETS.includes(target) || !needsUpagentRelease(checks)) return null;
  const db = releaseDbKey(env, target);
  const rel = checks[UPAGENT_RELEASE_KEY] || {};
  if (rel.db?.[db]) return null;
  // completed 只記 Bump～CleanStaging；Database 是否完成看 db[<env>_<target>]
  const done = rel.version ? RELEASE_STEPS.indexOf(rel.completed) : -1;
  const startFrom = RELEASE_STEPS[Math.min(done + 1, RELEASE_STEPS.length - 1)];
  return { env, target, db, startFrom, version: startFrom === 'Bump' ? undefined : rel.version };
}

/**
 * 正式環境排程重啟 App Service 的時段（Azure Automation 的 Schedule + Runbook，見 main/services/prodRestart.js）。
 * 正式環境有客戶在用，不立即重啟，只能排在這幾個時間。
 */
export const RESTART_SLOTS = [
  { key: 'lunch', label: '午休', time: '12:30' },
  { key: 'evening', label: '下班', time: '18:30' },
  { key: 'night', label: '深夜', time: '23:30' },
];
export const restartSlot = (key) => RESTART_SLOTS.find((s) => s.key === key) || null;
export const RESTART_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** 時間 → 時段名稱（例 '23:30' → '深夜'），不是預設時段時回傳 '' */
export const restartSlotLabel = (time) => RESTART_SLOTS.find((s) => s.time === time)?.label || '';
