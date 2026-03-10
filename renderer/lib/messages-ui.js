// ─── Message rendering — all DOM append functions ────────────────────────────

import { state } from './state.js';
import { uid, escHtml, formatMd, timestamp } from './utils.js';
import { thinkingTimers } from './abort.js';

// Injected callback — abortPersona lives in abort.js but setThinking needs it
let _abortPersona;
export function setAbortCallback(fn) { _abortPersona = fn; }

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
  const div  = document.createElement('div');
  div.className = 'message assistant-msg';

  let reasoningHtml = '';
  if (reasoning) {
    const ruid = `r-${id}-${Date.now()}`;
    reasoningHtml = `
      <div class="reasoning-block" id="${ruid}">
        <button class="reasoning-toggle" data-block-toggle="${ruid}">
          <span class="reasoning-arrow">▸</span> REASONING
        </button>
        <div class="reasoning-body">${escHtml(String(reasoning))}</div>
      </div>`;
  }

  let metaExtra = '';
  if (stats) {
    const tps  = stats.tokens_per_second     != null ? `${stats.tokens_per_second.toFixed(1)} tok/s` : null;
    const ttft = stats.time_to_first_token_seconds != null ? `${stats.time_to_first_token_seconds.toFixed(2)}s TTFT` : null;
    const parts = [tps, ttft].filter(Boolean);
    if (parts.length) metaExtra = ` · ${parts.join(' · ')}`;
  }

  div.innerHTML = `
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
  msgs.appendChild(div);
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
  const msgs = document.getElementById(`msgs-${id}`);
  const div  = document.createElement('div');
  div.className = 'message assistant-msg';
  div.innerHTML = `<div class="msg-bubble" style="opacity:0.7;font-style:italic">${formatMd(escHtml(text))}</div>`;
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
}

export function appendToolCallIndicator(id, toolName, input) {
  const msgs    = document.getElementById(`msgs-${id}`);
  const div     = document.createElement('div');
  div.className = 'message assistant-msg';
  const tcuid   = `tc-${id}-${Date.now()}`;
  const display = toolName.replace(/_/g, '.');
  const args    = JSON.stringify(input, null, 2);
  div.innerHTML = `
    <div class="reasoning-block tool-call-block" id="${tcuid}">
      <button class="reasoning-toggle tool-toggle" data-block-toggle="${tcuid}">
        <span class="reasoning-arrow">▸</span> ⟐ ${escHtml(display)}
      </button>
      <div class="reasoning-body">${escHtml(args)}</div>
    </div>`;
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
}

export function appendToolResultIndicator(id, toolName, resultStr) {
  const msgs    = document.getElementById(`msgs-${id}`);
  const div     = document.createElement('div');
  div.className = 'message assistant-msg';
  const display = toolName.replace(/_/g, '.');
  const preview = resultStr.length > 280 ? resultStr.slice(0, 280) + '…' : resultStr;
  div.innerHTML = `<div class="skill-indicator">✓ ${escHtml(display)} · <span style="opacity:0.65;font-style:italic">${escHtml(preview)}</span></div>`;
  msgs.appendChild(div);
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

export function finalizeStreamingBubble(bubble, text, reasoning, stats) {
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
