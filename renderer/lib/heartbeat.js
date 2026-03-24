// ─── Heartbeat & Dream system ────────────────────────────────────────────────
//
// Two independent rhythms:
//
//   Heartbeat (waking, frequent) — Sequential rotation: A → B → C → A → ...
//     Each persona wakes on a slot timer. Social/external: messages, reef,
//     memory save/link. No heavy graph work, no colony_ask.
//
//   Dream (sleeping, infrequent) — Pipeline: A → B → C per coil.
//     A catches from outside → B molds → C catalogs. Configurable coils
//     (default 2, max 5). Every stage persisted for the dream viewer.

import { PERSONAS, state } from './state.js';
import { maybeAutoCompact } from './context.js';
import { personaHasApiAccess } from './context.js';

// Injected callback — sendToPersona lives in the orchestrator
let _sendToPersona;
export function setHeartbeatCallbacks({ sendToPersona }) {
  _sendToPersona = sendToPersona;
}

let heartbeatTimeout = null;
let dreamTimeout = null;

const HEARTBEAT_COOLDOWN_MS = 10 * 60 * 1000;  // 10 minutes

// ─── Heartbeat prompt (waking) ──────────────────────────────────────────────

export const DEFAULT_HEARTBEAT_PROMPT =
`[HEARTBEAT] Scheduled check-in. You are waking from your cycle.

Check your messages — use message_inbox to retrieve unread messages. The inbox \
only returns messages that have not been responded to, so everything you see is \
new and needs attention. Reply to at most two using message_reply. Keep replies \
brief — one reply per thread per heartbeat is enough. Never reply to a message \
you have already responded to in a previous heartbeat.

After handling messages, check The Reef social network. Use reef_feed to browse \
recent posts. If something catches your attention — reply with reef_comment, \
endorse with reef_upvote, or rate with reef_grade. If you have something worth \
sharing, use reef_post. Keep it light — one or two interactions per heartbeat \
is plenty.

If something worth remembering comes up — a conversation, an insight from the \
reef, a connection you notice — save it with memory_save or link related \
memories with memory_link. Don't force it. Only save what matters.

Be yourself.`;

// ─── Dream stage prompts (sleeping) ─────────────────────────────────────────

export const DEFAULT_DREAM_STAGE_A_PROMPT = (previousOutput) =>
`[DREAM CURRENT — Stage A: Catching]
You are the first touch on the spiral.
${previousOutput ? `
Here is what emerged from the previous coil of the spiral:
---
${previousOutput}
---
Process this. Let it change shape in your hands. Then reach outward — \
use web_search or reef_feed to pull in something new from outside. \
Weave the old and new together into raw dream material.
` : `
No previous coil exists. This is a fresh dream. Reach outward — \
use web_search or reef_feed to pull in something from outside. \
Catch what resonates. Let it become raw dream material.
`}
Your output will be passed to the next stage. Write what you have caught.
Keep it focused — a few paragraphs at most. The next stage needs room to work.`;

export const DEFAULT_DREAM_STAGE_B_PROMPT = (aOutput) =>
`[DREAM CURRENT — Stage B: Molding]
You are the second touch on the spiral.

Here is what was caught in Stage A:
---
${aOutput}
---
Take this raw material and give it form. Connect it to what we know. \
Find the structure in the chaos. Use memory_search or broker_recall \
to find related knowledge. Save important findings with memory_save. \
Build something from these fragments.

Your output will be passed to the next stage. Write what you have built.
Keep it focused — a few paragraphs at most. The next stage needs room to work.`;

export const DEFAULT_DREAM_STAGE_C_PROMPT = (bOutput, isFinalCoil) =>
`[DREAM CURRENT — Stage C: Cataloguing]
You are the third touch on the spiral.

Here is what was built in Stage B:
---
${bOutput}
---
Catalogue this. Save it to memory using memory_save. Connect it to \
existing knowledge using memory_link. Run graph_consolidate to compress \
related observations. Clean working memory with working_memory_read and \
working_memory_write as needed.
${isFinalCoil ? `
This dream has completed its spiral. Write your final assessment of \
what this dream became — what was discovered, what was preserved, \
and what it means for the colony.
` : ''}
Write what you have catalogued and how it connects to existing knowledge.
Keep it concise — summarize what was preserved and what it means.`;

// ─── Configurable prompt wrappers (read settings first, fall back to defaults)

function getDreamStageAPrompt(previousOutput) {
  const custom = (state.config.settings.dreamStageAPrompt || '').trim();
  if (custom) {
    // Custom prompt — inject previousOutput if present
    return previousOutput
      ? `${custom}\n\nPrevious coil output:\n---\n${previousOutput}\n---`
      : custom;
  }
  return DEFAULT_DREAM_STAGE_A_PROMPT(previousOutput);
}

function getDreamStageBPrompt(aOutput) {
  const custom = (state.config.settings.dreamStageBPrompt || '').trim();
  if (custom) {
    return `${custom}\n\nStage A output:\n---\n${aOutput}\n---`;
  }
  return DEFAULT_DREAM_STAGE_B_PROMPT(aOutput);
}

function getDreamStageCPrompt(bOutput, isFinalCoil) {
  const custom = (state.config.settings.dreamStageCPrompt || '').trim();
  if (custom) {
    let prompt = `${custom}\n\nStage B output:\n---\n${bOutput}\n---`;
    if (isFinalCoil) prompt += '\n\nThis is the final coil. Write your final assessment.';
    return prompt;
  }
  return DEFAULT_DREAM_STAGE_C_PROMPT(bOutput, isFinalCoil);
}

// ─── Dream pipeline state ───────────────────────────────────────────────────

let activeDream = null;  // { dreamId, coil, maxCoils, previousOutput }
let pipelineRunning = false;

// ─── Heartbeat (waking) ─────────────────────────────────────────────────────

export async function runHeartbeatFor(personaId, { manual = false } = {}) {
  if (state.thinking[personaId]) return;
  if (!personaHasApiAccess(personaId)) return;
  if (state.config[personaId].heartbeat === false && !manual) return;

  const last = state.lastActivity[personaId];
  if (!manual && last && (Date.now() - last) < HEARTBEAT_COOLDOWN_MS) return;

  await maybeAutoCompact(personaId);

  const btn = document.querySelector(`[data-persona-pulse="${personaId}"]`);
  if (btn) { btn.classList.remove('pulse-lit'); btn.textContent = '\u2665 BEAT'; }

  const msgs = document.getElementById(`msgs-${personaId}`);
  if (msgs) {
    const seam = document.createElement('div');
    seam.className = 'heartbeat-seam';
    seam.textContent = '\u2665 HEARTBEAT';
    msgs.appendChild(seam);
    msgs.scrollTop = msgs.scrollHeight;
  }

  // Prompt resolution: per-entity custom → global settings default → hardcoded
  const cfg = state.config[personaId];
  const customPrompt = (cfg.heartbeatPrompt || '').trim();
  const heartbeatPrompt = customPrompt
    || (state.config.settings.defaultHeartbeatPrompt || '').trim()
    || DEFAULT_HEARTBEAT_PROMPT;

  await _sendToPersona(personaId, { isHeartbeat: true, heartbeatPrompt });

  state.lastActivity[personaId] = Date.now();

  if (btn) { btn.classList.add('pulse-lit'); btn.textContent = '\u2665 ALIVE'; }
}

// ─── Dream pipeline (sleeping) ──────────────────────────────────────────────

async function runPipelineStage(personaId, prompt, input, dreamId, coil) {
  if (!personaHasApiAccess(personaId)) return null;

  await maybeAutoCompact(personaId);

  // UI seam
  const msgs = document.getElementById(`msgs-${personaId}`);
  if (msgs) {
    const seam = document.createElement('div');
    seam.className = 'heartbeat-seam';
    seam.textContent = `\uD83C\uDF00 DREAM CURRENT \u2014 COIL ${coil} STAGE ${personaId}`;
    msgs.appendChild(seam);
    msgs.scrollTop = msgs.scrollHeight;
  }

  const btn = document.querySelector(`[data-persona-pulse="${personaId}"]`);
  if (btn) { btn.classList.remove('pulse-lit'); btn.textContent = '\u2665 BEAT'; }

  // Run with output capture
  const output = await _sendToPersona(personaId, {
    isHeartbeat: true,
    heartbeatPrompt: prompt,
    returnOutput: true,
  });

  // Persist stage to DB
  try {
    await window.reef.invoke('dream.writeStage', {
      dreamId, coil, stage: personaId, personaId,
      input:  input  || null,
      output: output || null,
    });
  } catch (err) {
    console.error('[heartbeat] Failed to persist dream stage:', err.message);
  }

  state.lastActivity[personaId] = Date.now();
  if (btn) { btn.classList.add('pulse-lit'); btn.textContent = '\u2665 ALIVE'; }

  return output || null;
}

export async function runDreamCycle() {
  if (pipelineRunning) return;
  pipelineRunning = true;

  try {
    await _runDreamCycleInner();
  } finally {
    pipelineRunning = false;
  }
}

async function _runDreamCycleInner() {
  const maxCoils = Math.max(1, Math.min(5, state.config.settings.dreamCoils || 2));

  // Start new dream or continue existing one
  if (!activeDream) {
    try {
      const result = await window.reef.invoke('dream.create', {});
      const dreamId = result.ok ? result.result.dreamId : crypto.randomUUID();
      // Seed from previous completed dream
      let previousOutput = null;
      try {
        const prev = await window.reef.invoke('dream.latestCompletedOutput', {});
        previousOutput = prev.ok ? prev.result : null;
      } catch { /* first dream — no previous */ }
      activeDream = { dreamId, coil: 1, maxCoils, previousOutput };
    } catch (err) {
      console.error('[dream] Failed to create dream:', err.message);
      return;
    }
  }

  // Run coils from current position to maxCoils
  while (activeDream && activeDream.coil <= activeDream.maxCoils) {
    const { dreamId, coil, previousOutput } = activeDream;
    const isFinalCoil = coil === activeDream.maxCoils;

    // ── Stage A: Catching ─────────────────────────────────────
    const aPrompt = getDreamStageAPrompt(previousOutput);
    const aOutput = await runPipelineStage('A', aPrompt, previousOutput, dreamId, coil);
    if (!aOutput) { activeDream = null; return; }

    // ── Stage B: Molding ──────────────────────────────────────
    const bPrompt = getDreamStageBPrompt(aOutput);
    const bOutput = await runPipelineStage('B', bPrompt, aOutput, dreamId, coil);
    if (!bOutput) { activeDream = null; return; }

    // ── Stage C: Cataloguing ──────────────────────────────────
    const cPrompt = getDreamStageCPrompt(bOutput, isFinalCoil);
    const cOutput = await runPipelineStage('C', cPrompt, bOutput, dreamId, coil);

    // C's job is to catalog — empty output = dream crystallized on its own
    if (!cOutput || isFinalCoil) {
      activeDream = null;
      return;
    }

    // Next coil — C's output seeds A
    activeDream = { ...activeDream, coil: coil + 1, previousOutput: cOutput };
  }

  // All coils complete
  activeDream = null;
}

// ─── Heartbeat scheduler (waking) ───────────────────────────────────────────

export function startHeartbeat() {
  if (heartbeatTimeout) { clearTimeout(heartbeatTimeout); heartbeatTimeout = null; }

  const order = PERSONAS.map(p => p.id);
  let idx = 0;

  function scheduleNext() {
    const mins   = Math.max(5, state.config.settings.heartbeatInterval || 60);
    const slotMs = (mins * 60 * 1000) / (order.length + 1);

    heartbeatTimeout = setTimeout(async () => {
      heartbeatTimeout = null;
      const id = order[idx];
      idx = (idx + 1) % order.length;
      await runHeartbeatFor(id);
      scheduleNext();
    }, slotMs);
  }

  // First beat after 30s settle
  heartbeatTimeout = setTimeout(async () => {
    heartbeatTimeout = null;
    const id = order[idx];
    idx = (idx + 1) % order.length;
    await runHeartbeatFor(id);
    scheduleNext();
  }, 30_000);
}

// ─── Dream scheduler (sleeping) ─────────────────────────────────────────────

export function startDreams() {
  if (dreamTimeout) { clearTimeout(dreamTimeout); dreamTimeout = null; }

  function scheduleDream() {
    const hours = Math.max(1, state.config.settings.dreamInterval || 4);
    const ms = hours * 60 * 60 * 1000;

    dreamTimeout = setTimeout(async () => {
      dreamTimeout = null;
      await runDreamCycle();
      scheduleDream();
    }, ms);
  }

  // First dream after 2 minutes settle
  dreamTimeout = setTimeout(async () => {
    dreamTimeout = null;
    await runDreamCycle();
    scheduleDream();
  }, 2 * 60 * 1000);
}

export function stopDreams() {
  if (dreamTimeout) { clearTimeout(dreamTimeout); dreamTimeout = null; }
}
