const fs = require('node:fs/promises');
const { Marked } = require('marked');
const { USER_GUIDE_FILE } = require('../paths');

/**
 * 使用手冊：讀 docs/user-guide.md（安裝版在 resources/docs/），用 marked 轉成 HTML 給 help.html 顯示。
 * 標題加上 id，讓 help.js 產生目錄與錨點連結（marked 預設不產生 heading id）。
 */
const plain = (html) => html.replace(/<[^>]+>/g, '').replace(/&[a-z#0-9]+;/gi, '').trim();

function createMarked() {
  const used = new Map();
  return new Marked({
    gfm: true,
    renderer: {
      heading({ tokens, depth }) {
        const inner = this.parser.parseInline(tokens);
        const base = plain(inner).toLowerCase().replace(/[\s　]+/g, '-').replace(/[^\p{L}\p{N}_-]/gu, '') || 'section';
        const n = used.get(base) || 0;
        used.set(base, n + 1);
        const id = n ? `${base}-${n}` : base;
        return `<h${depth} id="${id}">${inner}</h${depth}>\n`;
      },
    },
  });
}

async function loadUserGuide() {
  let md;
  try {
    md = await fs.readFile(USER_GUIDE_FILE, 'utf8');
  } catch (err) {
    throw new Error(`找不到使用手冊 ${USER_GUIDE_FILE}（${err.code || err.message}）`);
  }
  return { html: createMarked().parse(md) };
}

module.exports = { loadUserGuide };
