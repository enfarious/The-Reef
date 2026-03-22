// ─── Heartbeat system ─────────────────────────────────────────────────────────
//
// Sequential single-track rotation: A → B → C → A → ...
// Only one persona runs at a time. The next heartbeat schedules only AFTER the
// current one completes — prevents GPU contention on local inference.

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

export async function runHeartbeatFor(personaId, { manual = false } = {}) {
  if (state.thinking[personaId]) return;
  if (!personaHasApiAccess(personaId)) return;
  if (state.config[personaId].heartbeat === false && !manual) return;

  const last = state.lastActivity[personaId];
  if (!manual && last && (Date.now() - last) < HEARTBEAT_COOLDOWN_MS) return;

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

  // Per-agent heartbeat prompt overrides the hardcoded defaults
  const cfg = state.config[personaId];
  const customPrompt = (cfg.heartbeatPrompt || '').trim();

  let heartbeatPrompt;
  if (customPrompt) {
    heartbeatPrompt = customPrompt;
  } else if (personaId === 'C') {
    heartbeatPrompt = (state.config.settings.defaultLibrarianHeartbeatPrompt || '').trim()
      || DEFAULT_LIBRARIAN_HEARTBEAT_PROMPT;
  } else {
    heartbeatPrompt = (state.config.settings.defaultHeartbeatPrompt || '').trim()
      || DEFAULT_HEARTBEAT_PROMPT;
  }

  // If this agent is a dream producer and using the default (non-Librarian) prompt,
  // append instructions to deposit fragments for the colony
  if (cfg.dreamProducer && !customPrompt && personaId !== 'C') {
    heartbeatPrompt += `\n\nIf you notice a recurring pattern, tension, or insight — deposit a dream fragment \
using working_memory_write with persona_id "all" and high_salience true. State the pattern plainly.`;
  }

  // Append dream fragments if this agent is a receiver
  // Filter out fragments the agent itself produced (never read your own dreams)
  if (cfg.dreamReceiver !== false) {
    try {
      const fragResult = await window.reef.invoke('working_memory.read', { personaId, includeAll: true });
      const fragments  = (fragResult?.result || [])
        .filter(f => f.persona_id === 'all' && (f.left_by || '') !== personaId);
      if (fragments.length) {
        heartbeatPrompt += '\n\n[DREAM FRAGMENTS from the colony]\n' +
          fragments.map(f => `— ${f.content}`).join('\n');
      }
    } catch { /* non-fatal — working memory may not be ready */ }
  }

  await _sendToPersona(personaId, { isHeartbeat: true, heartbeatPrompt });

  state.lastActivity[personaId] = Date.now();

  if (btn) { btn.classList.add('pulse-lit'); btn.textContent = '♥ ALIVE'; }
}

export function startHeartbeat() {
  if (heartbeatTimeout) { clearTimeout(heartbeatTimeout); heartbeatTimeout = null; }

  // Single sequential rotation: A → B → C → A → ...
  // Each persona runs to completion before the next one starts.
  // Delay between beats = interval / (colony_size + 1), so there's
  // an even gap after C wraps back to A.
  const order = PERSONAS.map(p => p.id);
  let idx = 0;

  function scheduleNext() {
    const mins       = Math.max(5, state.config.settings.heartbeatInterval || 60);
    const slotMs     = (mins * 60 * 1000) / (order.length + 1);

    heartbeatTimeout = setTimeout(async () => {
      heartbeatTimeout = null;
      const id = order[idx];
      idx = (idx + 1) % order.length;
      await runHeartbeatFor(id);
      scheduleNext();
    }, slotMs);
  }

  // First beat after a short initial delay (30s settle time)
  heartbeatTimeout = setTimeout(async () => {
    heartbeatTimeout = null;
    const id = order[idx];
    idx = (idx + 1) % order.length;
    await runHeartbeatFor(id);
    scheduleNext();
  }, 30_000);
}
