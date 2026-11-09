import { PLAN_KEY, TEST_KEY, isCommitStage, commitsConfirmed, noRepoChange } from '../../shared/flow-rules.js';

/**
 * Requirement 流程的階段定義與純計算（不碰 DOM、不呼叫 api）。
 * 只有 renderer 用到；main 也需要的規則請放 shared/flow-rules.js。
 */

export const STAGES = [
  { key: 'pending', label: '待處理' },
  { key: 'implement', label: '開發' },
  { key: 'testDeploy', label: '測試環境佈版', checks: [['testDeploy.saas', 'SaaS'], ['testDeploy.local', 'Local']] },
  { key: 'test', label: '測試與檢核', checks: [[TEST_KEY, '測試 / 檢核完成']] },
  { key: 'prodDeploy', label: '正式環境佈版', checks: [['prodDeploy.saas', 'SaaS'], ['prodDeploy.local', 'Local']] },
  { key: 'recap', label: '功能發表', checks: [['recap.meeting', 'Meeting'], ['recap.record', 'Record']] },
];
export const DONE = { key: 'done', label: '已完成' };
/** 佈版階段的 SaaS checkbox key（勾選時走自動佈版流程） */
export const saasKey = (stage) => `${stage.key}.saas`;

/** 視為「開發完成」的子項目狀態（小寫比對） */
const DEV_DONE_STATES = new Set(['tested by dev', 'resolved', 'closed', 'done', 'completed']);
const isRemoved = (c) => String(c.state).toLowerCase() === 'removed';
export const isDevDone = (c) => DEV_DONE_STATES.has(String(c.state).toLowerCase());
export const activeKids = (req) => req.children.filter((c) => !isRemoved(c));
export const allDevDone = (req) => activeKids(req).length > 0 && activeKids(req).every(isDevDone);
export const stateClass = (s) => `state state-${String(s).toLowerCase().replace(/\s+/g, '-')}`;

/** 依子項目與 checkbox 計算 Requirement 目前所在階段 */
export function computeStage(req, checks) {
  if (!activeKids(req).length) return 'pending';
  if (!(allDevDone(req) && checks[PLAN_KEY])) return 'implement';
  for (const s of STAGES.slice(2)) {
    if (isCommitStage(s.key) && !commitsConfirmed(checks, s.key)) return s.key;
    // 不需修改 repository：佈版階段的 SaaS / Local 省略
    if (isCommitStage(s.key) && noRepoChange(checks)) continue;
    if (!s.checks.every(([k]) => checks[k])) return s.key;
  }
  return DONE.key;
}

/**
 * Requirement 在 ADO 應有的狀態（點擊狀態 chip 時更新成這個）：
 *   流程全部走完 → Closed；Implement 完成（子項目都 Tested by Dev / Resolved / Closed）→ Resolved；
 *   有子項目已指派給某人 → Active；其他情況沒有建議狀態（null）。
 */
export function expectedState(req) {
  if (req.stage === DONE.key) return 'Closed';
  if (allDevDone(req)) return 'Resolved';
  if (activeKids(req).some((c) => c.assignedTo)) return 'Active';
  return null;
}
export const sameState = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

export const stageIndex = (key) => (key === DONE.key ? STAGES.length : STAGES.findIndex((s) => s.key === key));
