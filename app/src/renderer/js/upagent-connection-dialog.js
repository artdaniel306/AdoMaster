import { api, cleanError } from './api.js';
import { $, el } from './dom.js';
import { UPAGENT_CONNECTIONS } from '../../shared/flow-rules.js';

/**
 * 設定 UpAgent 連線 dialog（測試 / 檢核階段，規劃含 upagent 時）：
 * 選 Local Test / Local Prod / SaaS Test / SaaS Prod → main 刪掉 UpAgent 設定檔 → 顯示該目標的 Activation Code 供複製。
 * 目前連線記在 localStorage（整台電腦只有一個 UpAgent，與 Requirement 無關）。
 */
const STORAGE_KEY = 'upagentConnection';

/** 目前的 UpAgent 連線 { key, label } 或 null */
export function currentUpagentConnection() {
  let key = null;
  try { key = localStorage.getItem(STORAGE_KEY); } catch { /* 忽略 */ }
  return UPAGENT_CONNECTIONS.find((t) => t.key === key) || null;
}

let instance = null;

export function createUpagentConnectionDialog() {
  if (instance) return instance;

  const dialog = $('upagent-conn-dialog');
  const form = $('uc-form');
  const reqEl = $('uc-req');
  const filesEl = $('uc-files');
  const targetsEl = $('uc-targets');
  const resultEl = $('uc-result');
  const resultMsg = $('uc-result-msg');
  const codeEl = $('uc-code');
  const copyBtn = $('uc-copy');
  const errorEl = $('uc-error');
  const okBtn = $('uc-ok');
  const cancelBtn = $('uc-cancel');
  const closeBtn = $('uc-close');

  let busy = false;
  let onChanged = null;
  let targets = []; // 上次讀到的 [{ key, label, hasCode }]

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.hidden = !msg;
  }

  function setBusy(v) {
    busy = v;
    okBtn.disabled = cancelBtn.disabled = closeBtn.disabled = v;
    for (const input of targetsEl.querySelectorAll('input')) {
      input.disabled = v || !targets.find((t) => t.key === input.value)?.hasCode;
    }
    okBtn.textContent = v ? '切換中…' : '切換連線';
  }

  const selected = () => targetsEl.querySelector('input:checked')?.value;

  function renderTargets() {
    const current = currentUpagentConnection()?.key;
    targetsEl.replaceChildren();
    for (const t of targets) {
      const label = el('label');
      const input = el('input');
      input.type = 'radio';
      input.name = 'uc-target';
      input.value = t.key;
      input.disabled = !t.hasCode;
      label.append(input, el('span', null, t.label));
      if (t.key === current) label.append(el('span', 'uc-tag', '（目前）'));
      if (!t.hasCode) {
        label.append(el('span', 'uc-tag warn', '未設定 Activation Code'));
        label.title = `請在 data/config.json 的 upagentConnection.activationCodes.${t.key} 設定`;
      }
      targetsEl.append(label);
    }
    okBtn.disabled = !targets.some((t) => t.hasCode);
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;
    const target = selected();
    if (!target) return showError('請選擇要連線的環境');
    setBusy(true);
    showError('');
    resultEl.hidden = true;
    try {
      const r = await api.switchUpagentConnection(target);
      try { localStorage.setItem(STORAGE_KEY, r.target); } catch { /* 忽略 */ }
      const lines = r.files.map((f) => (f.deleted ? `已刪除：${f.path}` : `檔案不存在（略過）：${f.path}`));
      resultMsg.textContent = `已切換到 ${r.label}。\n${lines.join('\n')}\n\n請重新開啟 UpAgent，並輸入以下 Activation Code：`;
      codeEl.value = r.activationCode;
      resultEl.hidden = false;
      copyBtn.textContent = '複製';
      renderTargets();
      onChanged?.(r);
      codeEl.select();
    } catch (err) {
      showError(`切換失敗：${cleanError(err)}`);
    } finally {
      setBusy(false);
    }
  });

  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(codeEl.value);
      copyBtn.textContent = '已複製 ✓';
    } catch {
      codeEl.select();
      copyBtn.textContent = '請按 Ctrl + C';
    }
  });

  dialog.addEventListener('cancel', (e) => {
    if (busy) e.preventDefault();
  });
  cancelBtn.addEventListener('click', () => dialog.close());
  closeBtn.addEventListener('click', () => dialog.close());

  /**
   * @param req Requirement（顯示標題用，可省略）
   * @param changedFn (result) => void；切換成功後呼叫（例如重繪顯示目前連線的格子）
   */
  async function open(req, changedFn) {
    onChanged = changedFn;
    showError('');
    resultEl.hidden = true;
    reqEl.textContent = req ? `#${req.id} ${req.title}` : '';
    reqEl.hidden = !req;
    filesEl.textContent = '讀取設定中…';
    targetsEl.replaceChildren();
    okBtn.disabled = true;
    dialog.showModal();
    try {
      const status = await api.upagentConnectionStatus();
      filesEl.textContent = status.files
        .map((f) => `要刪除的設定檔：${f.path}${f.exists ? '' : '（目前不存在）'}`)
        .join('\n');
      targets = status.targets;
      renderTargets();
    } catch (err) {
      filesEl.textContent = '';
      showError(cleanError(err));
    }
  }

  instance = { open };
  return instance;
}
