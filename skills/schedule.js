'use strict';

// ─── Task Scheduler ───────────────────────────────────────────────────────────
// In-memory one-shot and recurring task scheduling for colony personas.
// Tasks fire a desktop notification + write to working memory when due.
//
// schedule_task: queue a task to run after a delay or at a specific time
// schedule_list: list pending tasks
// schedule_cancel: cancel a task by ID

const crypto = require('crypto');

// task shape: { id, description, persona, fireAt, _timer }
const _tasks = new Map();

// ── helpers ───────────────────────────────────────────────────────────────────

function fireTask(task) {
  _tasks.delete(task.id);

  // Best-effort notification (Electron API may not be available in all contexts)
  try {
    const { Notification } = require('electron');
    if (Notification.isSupported()) {
      new Notification({
        title: `[${task.persona || 'Reef'}] Scheduled task`,
        body:  task.description,
      }).show();
    }
  } catch { /* non-fatal */ }

  // Best-effort working memory deposit
  try {
    const wm = require('./working-memory');
    wm.write({
      persona_id:   task.persona || 'all',
      content:      `[SCHEDULED] ${task.description}`,
      high_salience: false,
    }).catch(() => { /* non-fatal */ });
  } catch { /* non-fatal */ }

  console.log(`[schedule] Fired task ${task.id}: ${task.description}`);
}

// ── schedule_task ─────────────────────────────────────────────────────────────
// args: { description, delayMs?, runAt?, persona? }
//   description — what the task is for (plain text reminder)
//   delayMs     — fire after this many milliseconds from now
//   runAt       — ISO 8601 datetime string to fire at (alternative to delayMs)
//   persona     — persona ID who scheduled it ("dreamer", "builder", "librarian")
// Exactly one of delayMs or runAt is required.

async function scheduleTask({ description, delayMs, runAt, persona } = {}) {
  if (!description) throw new Error('description is required.');
  if (delayMs == null && !runAt) throw new Error('Either delayMs or runAt is required.');

  let ms;
  if (delayMs != null) {
    ms = Math.max(1000, Number(delayMs));
    if (!Number.isFinite(ms)) throw new Error('delayMs must be a number.');
  } else {
    const target = new Date(runAt);
    if (isNaN(target.getTime())) throw new Error(`Invalid runAt date: ${runAt}`);
    ms = target.getTime() - Date.now();
    if (ms < 1000) throw new Error('runAt must be in the future (at least 1 second).');
  }

  const id     = `task_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  const fireAt = new Date(Date.now() + ms).toISOString();

  const task = { id, description, persona: persona || null, fireAt };
  task._timer = setTimeout(() => fireTask(task), ms);
  _tasks.set(id, task);

  return {
    id,
    description,
    fireAt,
    delayMs: Math.round(ms),
    message: `Task scheduled for ${fireAt}`,
  };
}

// ── schedule_list ─────────────────────────────────────────────────────────────

async function listTasks({ persona } = {}) {
  const tasks = [..._tasks.values()].map(t => ({
    id:          t.id,
    description: t.description,
    persona:     t.persona,
    fireAt:      t.fireAt,
    msRemaining: Math.max(0, new Date(t.fireAt).getTime() - Date.now()),
  }));

  const filtered = persona
    ? tasks.filter(t => !t.persona || t.persona === persona)
    : tasks;

  filtered.sort((a, b) => a.msRemaining - b.msRemaining);
  return { count: filtered.length, tasks: filtered };
}

// ── schedule_cancel ───────────────────────────────────────────────────────────

async function cancelTask({ id } = {}) {
  if (!id) throw new Error('id is required.');
  const task = _tasks.get(id);
  if (!task) return { ok: false, message: `No task found with id: ${id}` };

  clearTimeout(task._timer);
  _tasks.delete(id);
  return { ok: true, message: `Task cancelled: ${task.description}` };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = { scheduleTask, listTasks, cancelTask };
