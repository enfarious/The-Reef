// ─── Heartbeat system ─────────────────────────────────────────────────────────
//
// Per-entity staggered heartbeat timers with cooldown guard.
// Uses self-rescheduling setTimeout so the next heartbeat fires only AFTER the
// current one completes — prevents accumulation and runaway cycling.

import { PERSONAS, state } from './state.js';
import { maybeAutoCompact } from './context.js';
import { personaHasApiAccess } from './context.js';

// Injected callback — sendToPersona lives in the orchestrator
let _sendToPersona;
export function setHeartbeatCallbacks({ sendToPersona }) {
  _sendToPersona = sendToPersona;
}

let heartbeatTimer  = null;
let heartbeatTimers = { A: null, B: null, C: null };

const HEARTBEAT_COOLDOWN_MS = 10 * 60 * 1000;  // 10 minutes

export const HEARTBEAT_PROMPT =
`[HEARTBEAT] Scheduled check-in. You are waking from your cycle.

Check your messages — use message_inbox to retrieve any unread correspondence \
from your colony members. If there are messages, read them and reply to at most \
two using message_reply. Keep replies brief and do not create long back-and-forth \
chains — one reply per thread per heartbeat is enough.

If your inbox is empty, act on your own initiative: save a memory, link related \
memories together, or send a message to a colony member. This is quiet time — \
for tending the garden, not for publishing.

Be yourself.`;

export const LIBRARIAN_HEARTBEAT_PROMPT =
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
7. Check your inbox with message_inbox. Reply to at most one message if it warrants a reply.

Do not engage in conversation. Report only: what you consolidated, what contradictions you resolved, \
what pattern you noticed (if any), what you linked, whether you sent a message.

The shelves are the work.`;

export async function runHeartbeatFor(personaId) {
  if (state.thinking[personaId]) return;
  if (!personaHasApiAccess(personaId)) return;

  const last = state.lastActivity[personaId];
  if (last && (Date.now() - last) < HEARTBEAT_COOLDOWN_MS) return;

  await maybeAutoCompact(personaId);

  const btn = document.querySelector(`[data-persona-pulse="${personaId}"]`);
  if (btn) { btn.classList.remove('pulse-lit'); btn.textContent = '♥ BEAT'; }

  const msgs = document.getElementById(`msgs-${personaId}`);
  if (msgs) {
    const seam = document.createElement('div');
    seam.className = 'heartbeat-seam';
    seam.textContent = '♥ HEARTBEAT';
    msgs.appendChild(seam);
    msgs.scrollTop = msgs.scrollHeight;
  }

  let heartbeatPrompt;
  if (personaId === 'C') {
    heartbeatPrompt = LIBRARIAN_HEARTBEAT_PROMPT;
  } else {
    let fragmentSuffix = '';
    try {
      const fragResult = await window.reef.invoke('working_memory.read', { personaId, includeAll: true });
      const fragments  = (fragResult?.result || []).filter(f => f.persona_id === 'all');
      if (fragments.length) {
        fragmentSuffix = '\n\n[DREAM FRAGMENTS from the Librarian]\n' +
          fragments.map(f => `— ${f.content}`).join('\n');
      }
    } catch { /* non-fatal — working memory may not be ready */ }
    heartbeatPrompt = HEARTBEAT_PROMPT + fragmentSuffix;
  }

  await _sendToPersona(personaId, { isHeartbeat: true, heartbeatPrompt });

  state.lastActivity[personaId] = Date.now();

  if (btn) { btn.classList.add('pulse-lit'); btn.textContent = '♥ ALIVE'; }
}

export function startHeartbeat() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  Object.keys(heartbeatTimers).forEach(id => {
    if (heartbeatTimers[id]) { clearTimeout(heartbeatTimers[id]); heartbeatTimers[id] = null; }
  });

  const mins       = Math.max(5, state.config.settings.heartbeatInterval || 60);
  const intervalMs = mins * 60 * 1000;

  function scheduleFor(id, delayMs) {
    heartbeatTimers[id] = setTimeout(async () => {
      heartbeatTimers[id] = null;
      await runHeartbeatFor(id);
      scheduleFor(id, intervalMs);
    }, delayMs);
  }

  PERSONAS.forEach(p => {
    const jitter = Math.floor(Math.random() * intervalMs);
    scheduleFor(p.id, jitter);
  });
}
