/**
 * 從 Requirement 流程啟動的佈版工作（SaaS 自動佈版 / Local 佈版 / UpAgent 發佈），讓「佈版進度」dialog 一併列出。
 * 這些工作的狀態在各自的 dialog 模組裡（renderer 記憶體），由 flow-deploy.js 註冊來源：
 *   registerDeploySource({ summary: () => null | { title, kind, text, active, failed }, show: () => void })
 */
const sources = [];

export function registerDeploySource(source) {
  sources.push(source);
}

/** 目前有工作的來源：[{ title, kind, text, active, failed, show }] */
export function flowDeployJobs() {
  return sources.flatMap((s) => {
    const j = s.summary();
    return j ? [{ ...j, show: s.show }] : [];
  });
}
