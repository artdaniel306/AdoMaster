const fs = require('node:fs/promises');
const path = require('node:path');
const { shell } = require('electron');
const { CUSTOMER_BUILD_DIR } = require('../paths');
const { git } = require('./git');
const { findRepo } = require('./repoConfig');
const localDeploy = require('./localDeploy');
const { CUSTOMER_KEY_RE, TARGET_LABEL } = require('../../shared/flow-rules.js');

/**
 * 「版本控制 → 查看客戶發佈版本…」：列出客戶環境 build 過的 image tar（只讀，不 build、不 fetch）。
 * tar 由 shell/Deploy-Local.ps1 輸出：data/customer_build/<saas|local>/<客戶 key>/<repo>/<appName>_<tag>.tar，
 *   tag = <客戶 key 小寫>-<commit 前 10 碼>[-<env 雜湊 8 碼>]
 * build 時間取 tar 檔的修改時間（先寫 .partial，成功才改名，所以就是 build 完成的時間）；
 * commit 資訊依序在開發用 clone（repos 的 path）、部署用資料夾（projectDir）查，都查不到時只顯示 commit 縮寫。
 */

const TARGETS = Object.keys(TARGET_LABEL);
/** 檔名中的 tag 尾巴：-<commit 10 碼>[-<env 雜湊 8 碼>].tar */
const TAG_TAIL_RE = /-([0-9a-f]{10})(?:-([0-9a-f]{8}))?\.tar$/;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function readDirs(dir) {
  try {
    return (await fs.readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
}

/**
 * 可選的客戶：config.json customerDeploy 中的客戶，加上 customer_build 底下有資料夾但已不在設定中的客戶。
 * @returns {{ saas: [{ key, label, configured }], local: [...] }}
 */
async function listCustomers() {
  const configured = await localDeploy.listCustomers();
  const out = {};
  for (const target of TARGETS) {
    const list = (configured[target] || []).map((c) => ({ key: c.key, label: c.label, configured: true }));
    for (const key of await readDirs(path.join(CUSTOMER_BUILD_DIR, target))) {
      if (CUSTOMER_KEY_RE.test(key) && !list.some((c) => c.key.toLowerCase() === key.toLowerCase())) {
        list.push({ key, label: key, configured: false });
      }
    }
    out[target] = list;
  }
  return out;
}

/** 依檔名推測 appName / commit / env 雜湊；不符合格式時回傳 null */
function parseTarName(file, customer) {
  const m = new RegExp(`^(.+)_${escapeRe(customer.toLowerCase())}-([0-9a-f]{10})(?:-([0-9a-f]{8}))?\\.tar$`).exec(file);
  if (m) return { appName: m[1], commit: m[2], envHash: m[3] || '' };
  // 客戶 key 改過大小寫以外的名稱時，至少取出 commit
  const t = TAG_TAIL_RE.exec(file);
  if (!t) return null;
  const head = file.slice(0, t.index);
  const i = head.indexOf('_');
  return { appName: i > 0 ? head.slice(0, i) : head, commit: t[1], envHash: t[2] || '' };
}

/** 在 cwd 查 commit：{ full, subject, author, date（commit 時間，ISO）, authorDate }；查不到回傳 null */
async function lookupCommit(cwd, commit) {
  try {
    const out = await git(cwd, ['log', '-1', '--format=%H%x00%s%x00%an%x00%cI%x00%aI', `${commit}^{commit}`, '--']);
    const [full, subject, author, date, authorDate] = out.trim().split('\0');
    return full ? { full, subject, author, date, authorDate } : null;
  } catch {
    return null;
  }
}

async function isDir(p) {
  try {
    return !!p && (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** 某 repository 可以查 commit 的 clone：開發用 clone、部署用資料夾（依序） */
async function cloneDirs(repo, target, customer) {
  const dirs = [];
  const r = await findRepo(repo);
  if (await isDir(r?.path)) dirs.push(r.path);
  try {
    const t = await localDeploy.customerTarget(repo, target, customer);
    if (t?.projectDir && (await isDir(t.projectDir)) && !dirs.some((d) => path.resolve(d).toLowerCase() === path.resolve(t.projectDir).toLowerCase())) {
      dirs.push(t.projectDir);
    }
  } catch {
    // 設定有問題時只用開發用 clone
  }
  return { label: r?.label || repo, dirs };
}

function checkParams(target, customer) {
  if (!TARGETS.includes(target) || !CUSTOMER_KEY_RE.test(customer || '')) throw new Error('參數錯誤');
}

/**
 * 某客戶的 image tar（新 → 舊）。
 * @returns {{ dir, images: [{ repo, repoLabel, file, size, builtAt, appName, envHash, commit, commitInfo }] }}
 */
async function listImages({ target, customer } = {}) {
  checkParams(target, customer);
  const dir = path.join(CUSTOMER_BUILD_DIR, target, customer);
  const images = [];
  for (const repo of await readDirs(dir)) {
    const repoDir = path.join(dir, repo);
    let files;
    try {
      files = (await fs.readdir(repoDir)).filter((f) => f.toLowerCase().endsWith('.tar'));
    } catch {
      continue;
    }
    if (!files.length) continue;
    const { label, dirs } = await cloneDirs(repo, target, customer);
    const commits = new Map(); // commit 縮寫 → Promise<commitInfo | null>（同一個 commit 只查一次）
    const lookupAll = async (c) => {
      for (const d of dirs) {
        const info = await lookupCommit(d, c);
        if (info) return info;
      }
      return null;
    };
    await Promise.all(
      files.map(async (file) => {
        let st;
        try {
          st = await fs.stat(path.join(repoDir, file));
        } catch {
          return;
        }
        const parsed = parseTarName(file, customer);
        if (parsed && !commits.has(parsed.commit)) commits.set(parsed.commit, lookupAll(parsed.commit));
        images.push({
          repo,
          repoLabel: label,
          file,
          size: st.size,
          builtAt: st.mtime.toISOString(),
          appName: parsed?.appName || '',
          envHash: parsed?.envHash || '',
          commit: parsed?.commit || '',
          commitInfo: parsed ? await commits.get(parsed.commit) : null,
        });
      }),
    );
  }
  images.sort((a, b) => b.builtAt.localeCompare(a.builtAt));
  return { dir, images };
}

/** 在檔案總管中顯示某個 image tar（每段路徑都檢查，只能指到 customer_build 底下的 .tar） */
async function revealImage({ target, customer, repo, file } = {}) {
  checkParams(target, customer);
  if (!CUSTOMER_KEY_RE.test(repo || '') || typeof file !== 'string' || !/^[A-Za-z0-9_.-]+\.tar$/i.test(file)) throw new Error('參數錯誤');
  const full = path.join(CUSTOMER_BUILD_DIR, target, customer, repo, file);
  try {
    await fs.access(full);
  } catch {
    throw new Error(`找不到檔案：${full}`);
  }
  shell.showItemInFolder(full);
  return true;
}

module.exports = { listCustomers, listImages, revealImage, parseTarName };
