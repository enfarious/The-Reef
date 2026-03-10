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

export function adoptBubbleAsAccumulator(id, bubble, pretextContent = null) {
  if (toolAccumulators[id]) {
    // Accumulator already exists from a prior iteration — move streamed tool blocks, discard bubble
    for (const block of bubble.querySelectorAll('.tool-call-block')) {
      toolAccumulators[id].appendChild(block);
    }
    bubble.remove();
    if (pretextContent) {
      const el = document.createElement('div');
      el.className = 'msg-bubble tool-pretext';
      el.innerHTML = formatMd(escHtml(pretextContent));
      toolAccumulators[id].appendChild(el);
    }
    return;
  }
  // First time — convert bubble to accumulator, preserving any tool-call-blocks from streaming
  const toolBlocks = [...bubble.querySelectorAll('.tool-call-block')];
  bubble.className = 'message assistant-msg tool-accumulator';
  bubble.innerHTML = '';
  for (const block of toolBlocks) bubble.appendChild(block);
  if (pretextContent) {
    const el = document.createElement('div');
    el.className = 'msg-bubble tool-pretext';
    el.innerHTML = formatMd(escHtml(pretextContent));
    bubble.appendChild(el);
  }
  toolAccumulators[id] = bubble;
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
        if (state.thinking[id]) _abortPersona(id, '⏱ TIMED OUT');
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
  // Consume any accumulated tool content
  const acc = toolAccumulators[id];
  delete toolAccumulators[id];

  // Collect tool-call-blocks: first from the streaming bubble itself, then from the accumulator
  let toolContentHtml = '';
  for (const block of bubble.querySelectorAll('.tool-call-block')) {
    toolContentHtml += block.outerHTML;
  }
  if (acc) {
    toolContentHtml += acc.innerHTML;
    acc.remove();
  }

  let reasoningHtml = '';
  if (reasoning) {
    const ruid = `r-${Date.now()}`;
    reasoningHtml = `
      <div class="reasoning-block open" id="${ruid}">
        <button class="reasoning-toggle" data-block-toggle="${ruid}">
          <span class="reasoning-arrow">▸</span> REASONING
        </button>
        <div class="reasoning-body">${escHtml(String(reasoning))}</div>
      </div>`;
  }

  let metaExtra = '';
  if (stats) {
    const tps  = stats.tokens_per_second           != null ? `${stats.tokens_per_second.toFixed(1)} tok/s` : null;
    const ttft = stats.time_to_first_token_seconds != null ? `${stats.time_to_first_token_seconds.toFixed(2)}s TTFT` : null;
    const parts = [tps, ttft].filter(Boolean);
    if (parts.length) metaExtra = ` · ${parts.join(' · ')}`;
  }

  bubble.className = 'message assistant-msg';
  bubble.innerHTML = `
    ${toolContentHtml}
    ${reasoningHtml}
    <div class="msg-bubble">${formatMd(escHtml(text))}</div>
    <div class="msg-meta-row">
      <span class="msg-meta">${timestamp()}${escHtml(metaExtra)}</span>
      <span class="msg-actions">
        <button class="msg-edit-btn" title="Edit">✎</button>
        <button class="msg-delete-btn" title="Remove from context">×</button>
      </span>
    </div>
  `;
  return bubble;
}
