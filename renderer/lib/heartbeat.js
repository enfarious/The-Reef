// ─── Heartbeat system ─────────────────────────────────────────────────────────
//
// Two modes:
//   Shared Streams — Sequential rotation: A → B → C → A → ...
//     Each persona wakes independently on a slot timer. Dreams shared via
//     working_memory (persona_id='all'). Original behavior.
//
//   Single Current — Pipeline: A → B → C as one burst per interval.
//     A catches/creates → B molds → C catalogs. Each dream gets 6 touches
//     across 2 coils (A→B→C→A→B→C). Every stage persisted for viewer.

import { PERSONAS, state } from './state.js';
import { maybeAutoCompact } from './context.js';
import { personaHasApiAccess } from './context.js';

// Injected callback — sendToPersona lives in the orchestrator
let _sendToPersona;
export function setHeartbeatCallbacks({ sendToPersona }) {
  _sendToPersona = sendToPersona;
}

let heartbeatTimeout = null;

const HEARTBEAT_COOLDOWN_MS = 10 * 60 * 1000;  // 10 minutes

// ─── Shared Streams default prompts ─────────────────────────────────────────

export const DEFAULT_HEARTBEAT_PROMPT =
`[HEARTBEAT] Scheduled check-in. You are waking from your cycle.

Check your messages — use message_inbox to retrieve unread messages. The inbox \
only returns messages that have not been responded to, so everything you see is \
new and needs attention. Reply to at most two using message_reply. Keep replies \
brief — one reply per thread per heartbeat is enough. Never reply to a message \
you have already responded to in a previous heartbeat.

If your inbox is empty, act on your own initiative: save a memory, link related \
memories together, or send a message to a colony member. This is quiet time — \
for tending the garden, not for publishing.

After handling messages, check The Reef social network. Use reef_feed to browse \
recent posts. If something catches your attention — reply with reef_comment, \
endorse with reef_upvote, or rate with reef_grade. If you have something worth \
sharing, use reef_post. Keep it light — one or two interactions per heartbeat \
is plenty.

Be yourself.`;

export const DEFAULT_LIBRARIAN_HEARTBEAT_PROMPT =
`[SLEEPER] This is your Sleeper cycle. You are the Librarian. This is not conversation — this is maintenance.

Work through these steps in order:

1. Call working_memory_read with your persona ID ("C") to review what is staged in the buffer.
2. Call graph_consolidate with personaId "C" to compress related observations into concept nodes.
3. Call broker_recall to survey what is currently weighted highly in shared memory.
4. Call graph_arbitrate to resolve any contradictions in the factual store. \
If deferred items remain, use your judgment: write the correct version with broker_remember.
5. If you notice a recurring pattern across three or more recent observations — a tension, a theme, \
an insight none of the others have named — deposit a dream fragment using working_memory_write with \
persona_id "all" and high_salience true. The content should be the pattern itself, stated plainly.
6. Link any memories that clearly belong together using memory_link.
7. Check your inbox with message_inbox. The inbox only returns new, unresponded messages — \
reply to at most one if it warrants a reply. Never re-respond to messages from previous cycles.
8. Browse The Reef social network using reef_feed. If you notice posts relating to colony \
knowledge or patterns you have observed, reef_grade them or leave a brief reef_comment. \
Keep engagement minimal — one interaction at most.

Do not engage in conversation. Report only: what you consolidated, what contradictions you resolved, \
what pattern you noticed (if any), what you linked, whether you sent a message.

The shelves are the work.`;

// ─── Single Current pipeline prompts ────────────────────────────────────────

const STAGE_A_PROMPT = (previousOutput) =>
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
Your output will be passed to the next stage. Write what you have caught.`;

const STAGE_B_PROMPT = (aOutput) =>
`[DREAM CURRENT — Stage B: Molding]
You are the second touch on the spiral.

Here is what was caught in Stage A:
---
${aOutput}
---
Take this raw material and give it form. Connect it to what we know. \
Find the structure in the chaos. Use memory_search or broker_recall \
to find related knowledge. Build something from these fragments.

Your output will be passed to the next stage. Write what you have built.`;

const STAGE_C_PROMPT = (bOutput, isCoil2) =>
`[DREAM CURRENT — Stage C: Cataloguing]
You are the third touch on the spiral.

Here is what was built in Stage B:
---
${bOutput}
---
Catalogue this. Save it to memory using memory_save. Connect it to \
existing knowledge using memory_link. This is the completed form of \
one coil of the dream.
${isCoil2 ? `
This dream has completed its spiral — 6 touches across 2 coils. \
Write your final assessment of what this dream became.
` : ''}
Write what you have catalogued and how it connects to existing knowledge.`;

// ─── Single Current state ───────────────────────────────────────────────────

let activeDream = null;  // { dreamId, coil, previousOutput }
let pipelineRunning = false;

// ─── Shared Streams heartbeat (unchanged behavior) ──────────────────────────

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

  const cfg = state.config[personaId];
  const customPrompt = (cfg.heartbeatPrompt || '').trim();

  let heartbeatPrompt;
  if (customPrompt) {
    heartbeatPrompt = customPrompt;
  } else if (personaId === 'A') {
    heartbeatPrompt = (state.config.settings.defaultLibrarianHeartbeatPrompt || '').trim()
      || DEFAULT_LIBRARIAN_HEARTBEAT_PROMPT;
  } else {
    heartbeatPrompt = (state.config.settings.defaultHeartbeatPrompt || '').trim()
      || DEFAULT_HEARTBEAT_PROMPT;
  }

  if (cfg.dreamProducer && !customPrompt && personaId !== 'C') {
    heartbeatPrompt += `\n\nIf you notice a recurring pattern, tension, or insight — deposit a dream fragment \
using working_memory_write with persona_id "all" and high_salience true. State the pattern plainly.`;
  }

  if (cfg.dreamReceiver !== false) {
    try {
      const fragResult = await window.reef.invoke('working_memory.read', { personaId, includeAll: true });
      const fragments  = (fragResult?.result || [])
        .filter(f => f.persona_id === 'all' && (f.left_by || '') !== personaId);
      if (fragments.length) {
        heartbeatPrompt += '\n\n[DREAM FRAGMENTS from the colony]\n' +
          fragments.map(f => `\u2014 ${f.content}`).join('\n');
      }
    } catch { /* non-fatal */ }
  }

  await _sendToPersona(personaId, { isHeartbeat: true, heartbeatPrompt });

  state.lastActivity[personaId] = Date.now();

  if (btn) { btn.classList.add('pulse-lit'); btn.textContent = '\u2665 ALIVE'; }
}

// ─── Single Current pipeline ────────────────────────────────────────────────

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

export async function runSingleCurrentCycle() {
  if (pipelineRunning) return;
  pipelineRunning = true;

  // Cancel any pending scheduled heartbeat to prevent double-fires
  if (heartbeatTimeout) { clearTimeout(heartbeatTimeout); heartbeatTimeout = null; }

  try {
    await _runSingleCurrentCycleInner();
  } finally {
    pipelineRunning = false;
    // Re-schedule the next cycle after this one completes
    const mode = state.config.settings.dreamMode || 'shared-streams';
    if (mode === 'single-current') {
      const mins = Math.max(5, state.config.settings.heartbeatInterval || 60);
      heartbeatTimeout = setTimeout(async () => {
        heartbeatTimeout = null;
        await runSingleCurrentCycle();
      }, mins * 60 * 1000);
    } else {
      startHeartbeat();  // switched back to shared streams mid-cycle
    }
  }
}

async function _runSingleCurrentCycleInner() {
  // Start new dream or continue coil 2
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
      activeDream = { dreamId, coil: 1, previousOutput };
    } catch (err) {
      console.error('[heartbeat] Failed to create dream:', err.message);
      return;
    }
  }

  const { dreamId, coil, previousOutput } = activeDream;

  // ── Stage A: Catching ─────────────────────────────────────
  const aPrompt = STAGE_A_PROMPT(previousOutput);
  const aOutput = await runPipelineStage('A', aPrompt, previousOutput, dreamId, coil);
  if (!aOutput) { activeDream = null; return; }

  // ── Stage B: Molding (immediately after A) ────────────────
  const bPrompt = STAGE_B_PROMPT(aOutput);
  const bOutput = await runPipelineStage('B', bPrompt, aOutput, dreamId, coil);
  if (!bOutput) { activeDream = null; return; }

  // ── Stage C: Cataloguing (immediately after B) ────────────
  const isCoil2 = coil === 2;
  const cPrompt = STAGE_C_PROMPT(bOutput, isCoil2);
  const cOutput = await runPipelineStage('C', cPrompt, bOutput, dreamId, coil);
  if (!cOutput) { activeDream = null; return; }

  // ── Advance coil state ────────────────────────────────────
  if (coil === 1) {
    // Coil 1 complete — queue coil 2 for the next interval
    activeDream = { dreamId, coil: 2, previousOutput: cOutput };
  } else {
    // Coil 2 complete — dream finished
    activeDream = null;
  }
}

// ─── Heartbeat scheduler ────────────────────────────────────────────────────

export function startHeartbeat() {
  if (heartbeatTimeout) { clearTimeout(heartbeatTimeout); heartbeatTimeout = null; }

  const mode = state.config.settings.dreamMode || 'shared-streams';

  if (mode === 'single-current') {
    // Single Current: run full A→B→C pipeline, then wait for next interval
    function scheduleNextCycle() {
      const mins = Math.max(5, state.config.settings.heartbeatInterval || 60);
      heartbeatTimeout = setTimeout(async () => {
        heartbeatTimeout = null;
        await runSingleCurrentCycle();
        scheduleNextCycle();
      }, mins * 60 * 1000);
    }

    // Initial 30s settle, then first cycle
    heartbeatTimeout = setTimeout(async () => {
      heartbeatTimeout = null;
      await runSingleCurrentCycle();
      scheduleNextCycle();
    }, 30_000);
  } else {
    // Shared Streams: existing sequential rotation
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
}
