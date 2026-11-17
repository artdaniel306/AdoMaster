const fs = require('node:fs/promises');
const { REMINDERS_FILE } = require('../paths');
const { writeFileAtomic } = require('../atomicWrite');
const { runScriptJson } = require('../python');

/**
 * 開發流程提醒（目前只有「提醒 Commit」，類型見 shared/flow-rules.js 的 REMINDER_TYPES）。
 * 每次提醒記一筆事件，統計時再彙整：
 * data/reminders.json → { "events": [{ type, email（小寫）, name, workItemId, url, at }] }
 */

const emailKey = (email) => String(email || '').trim().toLowerCase();

async function loadEvents() {
  try {
    const data = JSON.parse((await fs.readFile(REMINDERS_FILE, 'utf-8')).replace(/^﻿/, ''));
    return Array.isArray(data?.events) ? data.events : [];
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

let writeQueue = Promise.resolve(); // 序列化讀改寫，避免連續提醒時互相覆蓋

/** 加一筆事件 */
function addEvent(event) {
  const task = writeQueue.then(async () => {
    const events = await loadEvents();
    events.push(event);
    await writeFileAtomic(REMINDERS_FILE, JSON.stringify({ events }, null, 2));
  });
  writeQueue = task.catch(() => {});
  return task;
}

/**
 * 依「人員 × 類型」彙整：[{ email, name, type, count, lastAt, workItems: [{ id, url, count }] }]
 * （次數多的在前；workItems 依最後提醒時間新 → 舊）
 */
async function reminderSummary() {
  const groups = new Map();
  for (const e of await loadEvents()) {
    const k = `${e.email}\n${e.type}`;
    let g = groups.get(k);
    if (!g) groups.set(k, (g = { email: e.email, name: '', type: e.type, count: 0, lastAt: '', items: new Map() }));
    g.count += 1;
    if (e.name) g.name = e.name; // 事件依時間順序附加，以最後一筆的名字為準
    if (e.at > g.lastAt) g.lastAt = e.at;
    const wi = g.items.get(e.workItemId) || { id: e.workItemId, url: '', count: 0, lastAt: '' };
    wi.count += 1;
    if (e.url) wi.url = e.url;
    if (e.at > wi.lastAt) wi.lastAt = e.at;
    g.items.set(e.workItemId, wi);
  }
  return [...groups.values()]
    .map(({ items, ...g }) => ({
      ...g,
      workItems: [...items.values()]
        .sort((a, b) => b.lastAt.localeCompare(a.lastAt))
        .map(({ id, url, count }) => ({ id, url, count })),
    }))
    .sort((a, b) => b.count - a.count || b.lastAt.localeCompare(a.lastAt));
}

/** 「提醒 Commit」：留言 @ Work Item 的指派對象附上 commit 並記錄，回傳 { email, name } */
async function remindCommit({ id } = {}) {
  if (!Number.isInteger(id) || id <= 0) throw new Error('Work Item id 不正確');
  const { assignee, webUrl } = await runScriptJson('remind_commit.py', ['--id', String(id)]);
  const email = emailKey(assignee.email);
  const name = assignee.displayName || '';
  await addEvent({ type: 'commit', email, name, workItemId: id, url: webUrl || '', at: new Date().toISOString() });
  return { email, name };
}

module.exports = { remindCommit, reminderSummary };
