// ─── Scheduled tasks ─────────────────────────────────────────────────────────
// Entities schedule future messages to themselves via the schedule_task tool.

import { state, PERSONAS } from './state.js';
import { uid, formatDelay } from './utils.js';

let nextTaskId = 1;
export const scheduledTasks = new Map();

// Injected callbacks — set by the orchestrator at init time
let _sendToPersona, _appendUserMsg;
export function setSchedulerCallbacks({ sendToPersona, appendUserMsg }) {
  _sendToPersona = sendToPersona;
  _appendUserMsg = appendUserMsg;
}

export function scheduleTask(personaId, { delay, message }) {
  if (!message) throw new Error('message is required.');
  if (!delay || delay < 5000) throw new Error('delay must be at least 5000 ms (5 seconds).');
  const maxDelay = 24 * 60 * 60 * 1000;
  const ms = Math.min(Number(delay), maxDelay);

  const id = nextTaskId++;
  const fireAt = Date.now() + ms;
  const personaName = state.config[personaId]?.name
    || PERSONAS.find(p => p.id === personaId)?.name
    || personaId;

  const timer = setTimeout(() => {
    scheduledTasks.delete(id);
    const prompt = `[SCHEDULED REMINDER] You set this reminder ${formatDelay(ms)} ago:\n${message}`;
    state.conversations[personaId].push({ _id: uid(), role: 'user', content: prompt });
    const emptyEl = document.getElementById(`empty-${personaId}`);
    if (emptyEl) emptyEl.style.display = 'none';
    _appendUserMsg(personaId, `[scheduled] ${message}`);
    _sendToPersona(personaId);
  }, ms);

  scheduledTasks.set(id, { id, persona: personaId, personaName, message, fireAt, timer });

  const when = new Date(fireAt).toLocaleTimeString();
  return `Task #${id} scheduled — will fire in ${formatDelay(ms)} (at ${when}).`;
}

export function cancelTask(taskId) {
  const task = scheduledTasks.get(Number(taskId));
  if (!task) throw new Error(`Task #${taskId} not found.`);
  clearTimeout(task.timer);
  scheduledTasks.delete(Number(taskId));
  return `Task #${taskId} cancelled.`;
}

export function listTasks() {
  if (!scheduledTasks.size) return 'No scheduled tasks.';
  const now = Date.now();
  const lines = [];
  for (const t of scheduledTasks.values()) {
    const remaining = Math.max(0, t.fireAt - now);
    lines.push(`#${t.id} · ${t.personaName} · in ${formatDelay(remaining)} · "${t.message.slice(0, 80)}"`);
  }
  return lines.join('\n');
}
