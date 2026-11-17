const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { runScriptJson } = require('../python');
const { checkImages } = require('./testRecord');
const { IMAGE_EXT_BY_TYPE, BUG_TITLE_MAX, BUG_REPRO_MAX } = require('../../shared/flow-rules.js');

const EMAIL_MAX = 320;

/**
 * 測試與檢核的「記錄問題」：在 Requirement 底下建立 Bug（create_bug.py），回傳新 Bug（欄位同 children）。
 * 敘述與圖片寫進暫存資料夾再交給腳本（避免命令列長度 / 換行 / 引號問題），腳本上傳圖片並組成 Repro Steps。
 * @param id Requirement id
 * @param title Bug 標題
 * @param assignedTo 指派對象 email（Requirement 底下 Task 的指派對象，由腳本驗證）；空字串 = 不指派
 * @param repro Repro Steps 敘述（純文字）
 * @param images [{ type: 'image/png', data: Uint8Array }]
 */
async function createBug({ id, title, assignedTo = '', repro = '', images = [] } = {}) {
  if (!Number.isInteger(id) || id <= 0) throw new Error('參數錯誤');
  if (typeof title !== 'string' || typeof assignedTo !== 'string' || typeof repro !== 'string') throw new Error('參數錯誤');
  title = title.replace(/\s+/g, ' ').trim();
  assignedTo = assignedTo.trim();
  repro = repro.trim();
  if (!title) throw new Error('請輸入標題');
  if (title.length > BUG_TITLE_MAX) throw new Error(`標題最多 ${BUG_TITLE_MAX} 字`);
  if (assignedTo.length > EMAIL_MAX || /\s/.test(assignedTo)) throw new Error('參數錯誤');
  if (repro.length > BUG_REPRO_MAX) throw new Error(`敘述最多 ${BUG_REPRO_MAX} 字`);
  checkImages(images);

  const dir = path.join(os.tmpdir(), `ado-master-bug-${randomUUID()}`);
  try {
    await fs.mkdir(dir);
    const reproFile = path.join(dir, 'repro.txt');
    await fs.writeFile(reproFile, repro, 'utf-8');
    // --x=值：值以「-」開頭時 argparse 才不會誤認成選項
    const args = ['--parent', String(id), `--title=${title}`, '--repro-file', reproFile];
    if (assignedTo) args.push(`--assigned-to=${assignedTo}`);
    for (const [i, img] of images.entries()) {
      // 檔名會成為 ADO 附件名稱
      const file = path.join(dir, `image-${i + 1}.${IMAGE_EXT_BY_TYPE[img.type]}`);
      await fs.writeFile(file, img.data);
      args.push('--image', file);
    }
    return await runScriptJson('create_bug.py', args);
  } finally {
    fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { createBug };
