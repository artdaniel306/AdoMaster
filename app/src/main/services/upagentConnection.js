const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { readConfig, CONFIG_LABEL } = require('./appConfig');
const { UPAGENT_CONNECTIONS } = require('../../shared/flow-rules.js');

/**
 * 切換本機 UpAgent 的連線（Local Test / Local Prod / SaaS Test / SaaS Prod）。
 * 做法：刪掉 UpAgent 的設定檔（config.json upagentConnection.configFile），UpAgent 重新開啟後會要求輸入 Activation Code，
 * 再依 Code 自動連到對應的環境；Activation Code 依目標設定在 upagentConnection.activationCodes.<key>。
 *
 * config.json：
 *   "upagentConnection": {
 *     "configFile": "%APPDATA%\\upagent\\config.json",      // 字串或字串陣列；可用 %VAR% 與開頭的 ~
 *     "activationCodes": { "local_test": "...", "local_prod": "...", "saas_test": "...", "saas_prod": "..." }
 *   }
 */
const SECTION = 'upagentConnection';
const hint = (field) => `請在 ${CONFIG_LABEL} 的 ${SECTION}.${field} 設定`;

/** 展開 %VAR% 與開頭的 ~，並要求是絕對路徑 */
function expandPath(p) {
  let missing = null;
  let out = p.replace(/%([^%]+)%/g, (m, name) => {
    const v = process.env[name];
    if (v == null) missing ||= name;
    return v ?? m;
  });
  if (missing) throw new Error(`UpAgent 設定檔路徑中的環境變數 %${missing}% 不存在：${p}`);
  if (/^~(?=$|[\\/])/.test(out)) out = path.join(os.homedir(), out.slice(1));
  if (!path.isAbsolute(out)) throw new Error(`UpAgent 設定檔路徑必須是絕對路徑：${p}`);
  return path.normalize(out);
}

async function loadSection() {
  const section = (await readConfig())?.[SECTION];
  if (!section || typeof section !== 'object') throw new Error(`尚未設定 UpAgent 連線：${hint('configFile / activationCodes')}`);
  const raw = [].concat(section.configFile ?? []).filter((p) => typeof p === 'string' && p.trim());
  if (!raw.length) throw new Error(`尚未設定 UpAgent 設定檔路徑：${hint('configFile')}`);
  const codes = section.activationCodes && typeof section.activationCodes === 'object' ? section.activationCodes : {};
  return { files: raw.map((p) => expandPath(p.trim())), codes };
}

const codeOf = (codes, key) => (typeof codes[key] === 'string' ? codes[key].trim() : '');

/** dialog 開啟時的資訊：要刪除的檔案（是否存在）與各目標是否已設定 Activation Code */
async function connectionStatus() {
  const { files, codes } = await loadSection();
  const exists = await Promise.all(files.map((f) => fs.stat(f).then((s) => s.isFile(), () => false)));
  return {
    files: files.map((f, i) => ({ path: f, exists: exists[i] })),
    targets: UPAGENT_CONNECTIONS.map((t) => ({ ...t, hasCode: !!codeOf(codes, t.key) })),
  };
}

/**
 * 切換到 target：先確認有 Activation Code，再刪掉 UpAgent 設定檔（不存在就略過）。
 * @returns {{ target, label, activationCode, files: [{ path, deleted }] }}
 */
async function switchConnection({ target } = {}) {
  const conn = UPAGENT_CONNECTIONS.find((t) => t.key === target);
  if (!conn) throw new Error(`未知的 UpAgent 連線：${target}`);
  const { files, codes } = await loadSection();
  const activationCode = codeOf(codes, target);
  if (!activationCode) throw new Error(`尚未設定 ${conn.label} 的 Activation Code：${hint(`activationCodes.${target}`)}`);

  const results = [];
  for (const f of files) {
    try {
      await fs.unlink(f); // 只刪檔案；路徑是資料夾時 unlink 會失敗，不會整個資料夾刪掉
      results.push({ path: f, deleted: true });
    } catch (err) {
      if (err.code !== 'ENOENT') throw new Error(`刪除 UpAgent 設定檔失敗（${f}）：${err.message}`);
      results.push({ path: f, deleted: false });
    }
  }
  return { target, label: conn.label, activationCode, files: results };
}

module.exports = { connectionStatus, switchConnection };
