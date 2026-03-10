// ─── Tool-loop abort system ──────────────────────────────────────────────────

import { state, HARD_TOOL_CAP } from './state.js';
import { uid } from './utils.js';

export const abortFlags    = { A: false, B: false, C: false };
export const thinkingTimers = { A: null,  B: null,  C: null  };
export const activeStreams  = { A: null,  B: null,  C: null  };

export function getMaxToolSteps() {
  return Math.min(
    Math.max(1, state.config.settings?.maxToolSteps ?? 5),
    HARD_TOOL_CAP,
  );
}

export function abortPersona(id, reason = '⏱ TIMED OUT') {
  abortFlags[id] = true;

  const stream = activeStreams[id];
  if (stream?.abort) {
    stream.abort();
    const mode = stream.getMode?.();
    if (mode && mode !== 'anthropic') {
      state.conversations[id].push({
        _id: uid(), role: 'user', content: '[CANCEL_GENERATION]',
      });
    }
    activeStreams[id] = null;
  }

  const msgs = document.getElementById(`msgs-${id}`);
  if (msgs) {
    const seam = document.createElement('div');
    seam.className = 'timeout-seam';
    seam.textContent = reason;
    msgs.appendChild(seam);
    msgs.scrollTop = msgs.scrollHeight;
  }
}
