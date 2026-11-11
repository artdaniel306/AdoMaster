const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

/** 先寫到同資料夾的暫存檔再 rename 覆蓋：寫到一半中斷也不會留下壞掉的檔案（JSON / .env / 圖片…） */
async function writeFileAtomic(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`; // 同檔同時寫入時暫存檔不會撞名
  try {
    await fs.writeFile(tmp, data, 'utf-8');
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

module.exports = { writeFileAtomic };
