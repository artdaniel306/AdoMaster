const fs = require('node:fs/promises');
const { COMMIT_REMINDERS_FILE } = require('../paths');
const { writeFileAtomic } = require('../atomicWrite');
const { runScriptJson } = require('../python');

/**
 * 「提醒 Commit」：在 Work Item 留言 @ 指派的開發人員（remind_commit.py），並在本機記錄每個人被提醒的次數：
 * data/commit_reminders.json → { "<email 小寫>": { name, count, lastAt, lastWorkItemId } }
 */

const emailKey = (email) => String(email || '').trim().toLowerCase();

async function loadReminders() {
  try {
    return JSON.parse((await fs.readFile(COMMIT_REMINDERS_FILE, 'utf-8')).replace(/^﻿/, ''));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

/** 某位開發人員被提醒的次數（沒有記錄 = 0） */
async function reminderCount({ email } = {}) {
  const key = emailKey(email);
  if (!key) return 0;
  return (await loadReminders())[key]?.count || 0;
}

let writeQueue = Promise.resolve(); // 序列化讀改寫，避免連續提醒時互相覆蓋

function recordReminder(email, name, workItemId) {
  const task = writeQueue.then(async () => {
    const all = await loadReminders();
    const key = emailKey(email);
    const entry = { ...(all[key] || {}) };
    entry.name = name || entry.name || '';
    entry.count = (entry.count || 0) + 1;
    entry.lastAt = new Date().toISOString();
    entry.lastWorkItemId = workItemId;
    all[key] = entry;
    await writeFileAtomic(COMMIT_REMINDERS_FILE, JSON.stringify(all, null, 2));
    return entry;
  });
  writeQueue = task.catch(() => {});
  return task;
}

/** 留言提醒 Work Item 的指派對象附上 commit，回傳 { email, name, count }（count = 含這次的累計次數） */
async function remindCommit({ id } = {}) {
  if (!Number.isInteger(id) || id <= 0) throw new Error('Work Item id 不正確');
  const { assignee } = await runScriptJson('remind_commit.py', ['--id', String(id)]);
  const entry = await recordReminder(assignee.email, assignee.displayName, id);
  return { email: emailKey(assignee.email), name: entry.name, count: entry.count };
}

module.exports = { remindCommit, reminderCount };
