// ─── Message rendering — all DOM append functions ────────────────────────────

import { state } from './state.js';
import { uid, escHtml, formatMd, timestamp } from './utils.js';
import { thinkingTimers } from './abort.js';

// Injected callback — abortPersona lives in abort.js but setThinking needs it
let _abortPersona;
export function setAbortCallback(fn) { _abortPersona = fn; }

// ─── Tool accumulator — groups tool calls into a single bubble ──────────────

const toolAccumulators = {};

function getOrCreateToolAccumulator(id) {
  if (!toolAccumulators[id]) {
    const msgs = document.getElementById(`msgs-${id}`);
    const div = document.createElement('div');
    div.className = 'message assistant-msg tool-accumulator';
    const thinkInd = document.getElementById(`thinking-${id}`);
    if (thinkInd) msgs.insertBefore(div, thinkInd);
    else          msgs.appendChild(div);
    msgs.scrollTop = msgs.scrollHeight;
    toolAccumulators[id] = div;
  }
  return toolAccumulators[id];
}

export function adoptBubbleAsAccumulator(id, bubble) {
  // Convert streaming elements to static equivalents, preserving DOM order
  convertStreamingElements(bubble, 'tool-pretext');

  if (toolAccumulators[id]) {
    // Accumulator already exists — move all converted content into it
    while (bubble.firstChild) toolAccumulators[id].appendChild(bubble.firstChild);
    bubble.remove();
    const msgs = document.getElementById(`msgs-${id}`);
    msgs.scrollTop = msgs.scrollHeight;
    return;
  }

  // First time — convert bubble to accumulator in place
  bubble.className = 'message assistant-msg tool-accumulator';
  toolAccumulators[id] = bubble;
}

// Convert streaming DOM elements to their static equivalents (preserves DOM order)
function convertStreamingElements(container, textClass = '') {
  container.querySelector('.stream-tool-strip')?.remove();
  container.querySelectorAll('.stream-cursor').forEach(c => c.remove());

  // Convert reasoning wraps to collapsible reasoning blocks
  for (const rWrap of [...container.querySelectorAll('.stream-reasoning-wrap')]) {
    const bodyEl = rWrap.querySelector('.stream-reasoning-body');
    const rText  = bodyEl?.textContent?.trim();
    if (rText) {
      const ruid = `r-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const rBlock = document.createElement('div');
      rBlock.className = 'reasoning-block';
      rBlock.id = ruid;
      rBlock.innerHTML = `
        <button class="reasoning-toggle" data-block-toggle="${ruid}">
          <span class="reasoning-arrow">▸</span> REASONING
        </button>
        <div class="reasoning-body">${escHtml(rText)}</div>`;
      rWrap.replaceWith(rBlock);
    } else {
      rWrap.remove();
    }
  }

  // Convert text wraps to msg-bubbles
  for (const wrap of [...container.querySelectorAll('.stream-text-wrap')]) {
    const textEl = wrap.querySelector('.stream-text');
    const segText = textEl?.textContent?.trim();
    if (segText) {
      const el = document.createElement('div');
      el.className = textClass ? `msg-bubble ${textClass}` : 'msg-bubble';
      el.innerHTML = formatMd(escHtml(segText));
      wrap.replaceWith(el);
    } else {
      wrap.remove();
    }
  }
}

export function clearToolAccumulator(id) {
  delete toolAccumulators[id];
}

// ─── Message append functions ───────────────────────────────────────────────

export function appendUserMsg(id, displayText, modelContent = null) {
  const msgs = document.getElementById(`msgs-${id}`);
  const empty = document.getElementById(`empty-${id}`);
  if (empty) empty.style.display = 'none';

  const div = document.createElement('div');
  div.className = 'message user-msg';

  const msgId = uid();
  div.innerHTML = `
    <div class="msg-bubble">${escHtml(displayText)}</div>
    <div class="msg-meta-row">
      <span class="msg-meta">${timestamp()}</span>
      <span class="msg-actions">
        <button class="msg-edit-btn" title="Edit">✎</button>
        <button class="msg-delete-btn" title="Remove from context">×</button>
      </span>
    </div>
  `;
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;

  state.conversations[id].push({ _id: msgId, role: 'user', content: modelContent ?? displayText });
  div.dataset.personaId = id;
  div.dataset.msgId     = msgId;
}

export function appendAssistantMsg(id, text, reasoning = null, stats = null) {
  const msgs = document.getElementById(`msgs-${id}`);

  // Consume any accumulated tool content
  const acc = toolAccumulators[id];
  delete toolAccumulators[id];

  const div = acc || document.createElement('div');
  if (acc) {
    div.classList.remove('tool-accumulator');
  } else {
    div.className = 'message assistant-msg';
  }

  // Reasoning block (after tools, before text)
  if (reasoning) {
    const ruid = `r-${id}-${Date.now()}`;
    const rBlock = document.createElement('div');
    rBlock.className = 'reasoning-block';
    rBlock.id = ruid;
    rBlock.innerHTML = `
      <button class="reasoning-toggle" data-block-toggle="${ruid}">
        <span class="reasoning-arrow">▸</span> REASONING
      </button>
      <div class="reasoning-body">${escHtml(String(reasoning))}</div>`;
    div.appendChild(rBlock);
  }

  // Message text
  let metaExtra = '';
  if (stats) {
    const tps  = stats.tokens_per_second     != null ? `${stats.tokens_per_second.toFixed(1)} tok/s` : null;
    const ttft = stats.time_to_first_token_seconds != null ? `${stats.time_to_first_token_seconds.toFixed(2)}s TTFT` : null;
    const parts = [tps, ttft].filter(Boolean);
    if (parts.length) metaExtra = ` · ${parts.join(' · ')}`;
  }

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  bubble.innerHTML = formatMd(escHtml(text));
  div.appendChild(bubble);

  const meta = document.createElement('div');
  meta.className = 'msg-meta-row';
  meta.innerHTML = `
    <span class="msg-meta">${timestamp()}${escHtml(metaExtra)}</span>
    <span class="msg-actions">
      <button class="msg-edit-btn" title="Edit">✎</button>
      <button class="msg-delete-btn" title="Remove from context">×</button>
    </span>`;
  div.appendChild(meta);

  if (!acc) msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
  return div;
}

export function appendError(id, msg) {
  const msgs = document.getElementById(`msgs-${id}`);
  const div = document.createElement('div');
  div.className = 'message assistant-msg';
  div.innerHTML = `<div class="error-bubble">ERR: ${escHtml(msg)}</div>`;
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
}

export function appendToolTextMsg(id, text) {
  const acc = getOrCreateToolAccumulator(id);
  const el = document.createElement('div');
  el.className = 'msg-bubble tool-pretext';
  el.innerHTML = formatMd(escHtml(text));
  acc.appendChild(el);
  const msgs = document.getElementById(`msgs-${id}`);
  msgs.scrollTop = msgs.scrollHeight;
}

export function appendToolCallIndicator(id, toolName, input) {
  const acc     = getOrCreateToolAccumulator(id);
  const tcuid   = `tc-${id}-${Date.now()}`;
  const display = toolName.replace(/_/g, '.');
  const args    = JSON.stringify(input, null, 2);
  const block   = document.createElement('div');
  block.className = 'reasoning-block tool-call-block';
  block.id = tcuid;
  block.innerHTML = `
    <button class="reasoning-toggle tool-toggle" data-block-toggle="${tcuid}">
      <span class="reasoning-arrow">▸</span> ⟐ ${escHtml(display)}
    </button>
    <div class="reasoning-body">${escHtml(args)}</div>`;
  acc.appendChild(block);
  const msgs = document.getElementById(`msgs-${id}`);
  msgs.scrollTop = msgs.scrollHeight;
}

export function appendToolResultIndicator(id, toolName, resultStr) {
  const acc     = getOrCreateToolAccumulator(id);
  const display = toolName.replace(/_/g, '.');
  const preview = resultStr.length > 280 ? resultStr.slice(0, 280) + '…' : resultStr;
  const el      = document.createElement('div');
  el.className = 'skill-indicator';
  el.innerHTML = `✓ ${escHtml(display)} · <span style="opacity:0.65;font-style:italic">${escHtml(preview)}</span>`;
  acc.appendChild(el);
  const msgs = document.getElementById(`msgs-${id}`);
  msgs.scrollTop = msgs.scrollHeight;
}

export function appendTransmissionMsg(id, fromName, message) {
  const msgs    = document.getElementById(`msgs-${id}`);
  const div     = document.createElement('div');
  div.className = 'message assistant-msg';
  div.innerHTML = `
    <div class="transmission-indicator">
      ◈ TRANSMISSION FROM ${escHtml(fromName)}
      <div class="transmission-body">${escHtml(message)}</div>
    </div>`;
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
}

export function appendOperatorBadge(id, msgs) {
  const { operatorName, operatorAbout } = state.config.settings;
  if (!operatorName && !operatorAbout) return;
  const name  = operatorName;
  const badge = document.createElement('div');
  badge.className = 'message assistant-msg';
  badge.innerHTML = `<div class="skill-indicator">◈ operator context loaded${name ? ' — ' + escHtml(name) : ''}</div>`;
  msgs.appendChild(badge);
}

export function setThinking(id, thinking) {
  state.thinking[id] = thinking;
  const dot     = document.getElementById(`dot-${id}`);
  const msgs    = document.getElementById(`msgs-${id}`);
  const stopBtn = document.getElementById(`stop-${id}`);

  if (thinkingTimers[id]) {
    clearTimeout(thinkingTimers[id]);
    thinkingTimers[id] = null;
  }

  if (thinking) {
    dot.className = 'status-dot thinking';

    const maxSecs = state.config.settings?.maxThinkingTime ?? 120;
    if (maxSecs > 0) {
      thinkingTimers[id] = setTimeout(() => {
        if (state.thinking[id]) {
          const ind = document.getElementById(`thinking-${id}`);
          if (ind) {
            const label = document.createElement('div');
            label.className = 'timeout-label';
            label.textContent = '⏱ generation running longer than expected…';
            ind.appendChild(label);
            msgs.scrollTop = msgs.scrollHeight;
          }
        }
      }, maxSecs * 1000);
    }

    if (stopBtn) stopBtn.style.display = '';

    const indicator = document.createElement('div');
    indicator.className = 'message assistant-msg';
    indicator.id = `thinking-${id}`;
    indicator.innerHTML = `<div class="thinking-indicator">
      <div class="thinking-dot"></div>
      <div class="thinking-dot"></div>
      <div class="thinking-dot"></div>
    </div>`;
    msgs.appendChild(indicator);
    msgs.scrollTop = msgs.scrollHeight;
  } else {
    dot.className = 'status-dot online';
    if (stopBtn) stopBtn.style.display = 'none';
    const ind = document.getElementById(`thinking-${id}`);
    if (ind) ind.remove();
  }
}

export function finalizeStreamingBubble(id, bubble, text, reasoning, stats) {
  // Consume any accumulated tool content from prior iterations
  const acc = toolAccumulators[id];
  delete toolAccumulators[id];

  // --- Remove streaming chrome ---
  bubble.querySelector('.stream-tool-strip')?.remove();
  bubble.querySelectorAll('.stream-cursor').forEach(c => c.remove());

  // --- Convert all reasoning wraps to proper reasoning blocks (preserves position) ---
  const reasonWraps = [...bubble.querySelectorAll('.stream-reasoning-wrap')];
  if (reasonWraps.length) {
    for (const rWrap of reasonWraps) {
      const bodyEl = rWrap.querySelector('.stream-reasoning-body');
      const rText  = bodyEl?.textContent?.trim();
      if (rText) {
        const ruid = `r-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const rBlock = document.createElement('div');
        rBlock.className = 'reasoning-block';
        rBlock.id = ruid;
        rBlock.innerHTML = `
          <button class="reasoning-toggle" data-block-toggle="${ruid}">
            <span class="reasoning-arrow">▸</span> REASONING
          </button>
          <div class="reasoning-body">${escHtml(rText)}</div>`;
        rWrap.replaceWith(rBlock);
      } else {
        rWrap.remove();
      }
    }
  } else if (reasoning) {
    // Fallback: reasoning came only in the final result (not streamed)
    const ruid = `r-${Date.now()}`;
    const rBlock = document.createElement('div');
    rBlock.className = 'reasoning-block';
    rBlock.id = ruid;
    rBlock.innerHTML = `
      <button class="reasoning-toggle" data-block-toggle="${ruid}">
        <span class="reasoning-arrow">▸</span> REASONING
      </button>
      <div class="reasoning-body">${escHtml(String(reasoning))}</div>`;
    bubble.insertBefore(rBlock, bubble.firstChild);
  }

  // --- Convert text wraps to msg-bubbles (preserves interleaved order) ---
  for (const wrap of [...bubble.querySelectorAll('.stream-text-wrap')]) {
    const textEl = wrap.querySelector('.stream-text');
    const segText = textEl?.textContent?.trim();
    if (segText) {
      const msgBubble = document.createElement('div');
      msgBubble.className = 'msg-bubble';
      msgBubble.innerHTML = formatMd(escHtml(segText));
      wrap.replaceWith(msgBubble);
    } else {
      wrap.remove();
    }
  }

  // --- Prepend accumulated tool content from prior iterations ---
  if (acc) {
    const fragment = document.createDocumentFragment();
    while (acc.firstChild) fragment.appendChild(acc.firstChild);
    bubble.insertBefore(fragment, bubble.firstChild);
    acc.remove();
  }

  // --- Append meta row ---
  let metaExtra = '';
  if (stats) {
    const tps  = stats.tokens_per_second           != null ? `${stats.tokens_per_second.toFixed(1)} tok/s` : null;
    const ttft = stats.time_to_first_token_seconds != null ? `${stats.time_to_first_token_seconds.toFixed(2)}s TTFT` : null;
    const parts = [tps, ttft].filter(Boolean);
    if (parts.length) metaExtra = ` · ${parts.join(' · ')}`;
  }

  const meta = document.createElement('div');
  meta.className = 'msg-meta-row';
  meta.innerHTML = `
    <span class="msg-meta">${timestamp()}${escHtml(metaExtra)}</span>
    <span class="msg-actions">
      <button class="msg-edit-btn" title="Edit">✎</button>
      <button class="msg-delete-btn" title="Remove from context">×</button>
    </span>`;
  bubble.appendChild(meta);

  bubble.className = 'message assistant-msg';
  return bubble;
}
