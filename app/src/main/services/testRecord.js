const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { TEST_RECORDS_DIR } = require('../paths');
const { loadFlowState, updateRequirementState } = require('./requirementFlow');
const { TEST_KEY, TEST_RECORD_KEY, TEST_IMAGE_RE } = require('../../shared/flow-rules.js');

/**
 * 測試完成時記錄的測試場景：文字存在 data/requirement_flow_state.json 的 testRecord，
 * 圖片存成檔案 data/test_records/<requirementId>/<檔名>（state 只記檔名）。
 */
const NOTE_MAX = 4000;
const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const IMAGES_MAX = 30;
const EXT_BY_TYPE = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
};
const TYPE_BY_EXT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' };

const recordDir = (id) => path.join(TEST_RECORDS_DIR, String(id));
const typeOf = (name) => TYPE_BY_EXT[path.extname(name).slice(1).toLowerCase()];

/**
 * 儲存測試記錄。
 * @param id Requirement id
 * @param note 測試場景描述
 * @param keep 要保留的既有圖片檔名（不在其中的既有圖片會被刪除）
 * @param images 新增的圖片 [{ type: 'image/png', data: Uint8Array }]
 * @param check true = 同時勾起「測試完成」；false = 只更新記錄，不變更勾選狀態
 * @returns 該 Requirement 更新後的狀態
 */
async function saveTestRecord({ id, note, keep = [], images = [], check = false } = {}) {
  if (!Number.isInteger(id) || id <= 0) throw new Error('參數錯誤');
  if (note != null && typeof note !== 'string') throw new Error('參數錯誤');
  if (!Array.isArray(keep) || !keep.every((n) => typeof n === 'string' && TEST_IMAGE_RE.test(n))) throw new Error('參數錯誤');
  if (!Array.isArray(images)) throw new Error('參數錯誤');
  note = (note || '').trim();
  if (note.length > NOTE_MAX) throw new Error(`測試記錄最多 ${NOTE_MAX} 字`);
  if (keep.length + images.length > IMAGES_MAX) throw new Error(`圖片最多 ${IMAGES_MAX} 張`);
  for (const img of images) {
    if (!img || !EXT_BY_TYPE[img.type] || !(img.data instanceof Uint8Array)) throw new Error('不支援的圖片格式');
    if (img.data.byteLength > IMAGE_MAX_BYTES) throw new Error(`單張圖片最大 ${IMAGE_MAX_BYTES / 1024 / 1024} MB`);
  }

  // 先寫新圖片，state 存檔成功後才刪掉不再使用的舊圖片
  const dir = recordDir(id);
  const added = [];
  try {
    if (images.length) await fs.mkdir(dir, { recursive: true });
    for (const img of images) {
      const name = `${Date.now()}-${randomUUID().slice(0, 8)}.${EXT_BY_TYPE[img.type]}`;
      await fs.writeFile(path.join(dir, name), img.data);
      added.push(name);
    }
    const checks = await updateRequirementState(id, (c) => {
      const current = c[TEST_RECORD_KEY]?.images || [];
      if (keep.some((n) => !current.includes(n))) throw new Error('測試記錄已變更，請重新開啟後再儲存');
      const all = [...keep, ...added];
      if (note || all.length) c[TEST_RECORD_KEY] = { note, images: all, updatedAt: new Date().toISOString() };
      else delete c[TEST_RECORD_KEY];
      if (check) c[TEST_KEY] = true;
    });
    await removeUnused(id, checks[TEST_RECORD_KEY]?.images || []);
    return checks;
  } catch (err) {
    await Promise.all(added.map((n) => fs.rm(path.join(dir, n), { force: true }).catch(() => {})));
    throw err;
  }
}

/** 刪除資料夾中不在記錄內的圖片（資料夾空了就一併刪除） */
async function removeUnused(id, used) {
  const dir = recordDir(id);
  let names;
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  const unused = names.filter((n) => TEST_IMAGE_RE.test(n) && !used.includes(n));
  await Promise.all(unused.map((n) => fs.rm(path.join(dir, n), { force: true })));
  if (!used.length) await fs.rmdir(dir).catch(() => {}); // 還有其他檔案時刪不掉，忽略
}

/**
 * 讀取測試記錄的圖片。
 * @returns {Promise<[{ name, type, data: Buffer | null }]>} 檔案遺失時 data 為 null
 */
async function loadTestImages({ id } = {}) {
  if (!Number.isInteger(id) || id <= 0) throw new Error('參數錯誤');
  const names = (await loadFlowState())[id]?.[TEST_RECORD_KEY]?.images || [];
  return Promise.all(
    names
      .filter((n) => TEST_IMAGE_RE.test(n))
      .map(async (name) => {
        try {
          return { name, type: typeOf(name), data: await fs.readFile(path.join(recordDir(id), name)) };
        } catch (err) {
          if (err.code === 'ENOENT') return { name, type: typeOf(name), data: null };
          throw err;
        }
      })
  );
}

module.exports = { saveTestRecord, loadTestImages };
