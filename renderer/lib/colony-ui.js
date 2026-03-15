// ─── Colony UI construction ──────────────────────────────────────────────────

import { PERSONAS, state } from './state.js';
import { applyPersonaColor } from './color.js';

export function buildColony() {
  const colony = document.getElementById('colony');
  colony.innerHTML = '';
  PERSONAS.forEach(p => {
    const col = document.createElement('div');
    col.className = 'persona-col';
    col.dataset.persona = p.id;
    col.id = `col-${p.id}`;
    col.innerHTML = `
      <div class="col-header">
        <div class="col-header-top">
          <div>
            <div class="persona-name" id="name-${p.id}">${p.name}</div>
            <div class="persona-role" id="role-${p.id}">${p.role}</div>
          </div>
          <div style="display:flex;gap:6px;align-items:center;">
            <button class="reef-post-btn agent-picker-btn" data-agent-picker="${p.id}" title="Switch agent">▾</button>
            <button class="reef-post-btn entity-settings-btn" data-entity-settings="${p.id}" title="Entity settings">⚙</button>
            <button class="reef-post-btn" data-persona-wake="${p.id}">⟳ WAKE</button>
            <button class="reef-post-btn" data-persona-pulse="${p.id}" title="Trigger heartbeat check-in">♥ BEAT</button>
            <span class="ctx-counter" id="ctx-${p.id}" title="Context size (messages · estimated tokens)">0</span>
            <button class="reef-post-btn" data-persona-fold="${p.id}" title="Compact context to memory">⊡ FOLD</button>
            <button class="reef-post-btn" data-persona-post="${p.id}">→ REEF</button>
            <button class="reef-post-btn stop-btn" id="stop-${p.id}" data-persona-stop="${p.id}" title="Interrupt this entity" style="display:none">✕</button>
            <div class="status-dot" id="dot-${p.id}"></div>
          </div>
        </div>
        <div class="endpoint-bar">
          <input class="endpoint-input" id="endpoint-${p.id}" value="${p.defaultEndpoint}" placeholder="endpoint url" style="flex:1.8">
          <input class="endpoint-input" id="apikey-${p.id}" type="password" placeholder="api key" style="flex:1">
          <select class="model-select" id="model-${p.id}">
            <option value="claude-opus-4-6" ${p.defaultModel === 'claude-opus-4-6' ? 'selected' : ''}>opus-4.6</option>
            <option value="claude-sonnet-4-6" ${p.defaultModel === 'claude-sonnet-4-6' ? 'selected' : ''}>sonnet-4.6</option>
            <option value="claude-haiku-4-5-20251001">haiku-4.5</option>
            <option value="custom">custom…</option>
          </select>
          <button class="model-refresh-btn" data-persona-refresh="${p.id}" title="Fetch available models from endpoint">⟳</button>
        </div>

      </div>
      <div class="messages" id="msgs-${p.id}">
        <div class="empty-state" id="empty-${p.id}">
          <div class="empty-glyph">◈</div>
          <div class="empty-text">DORMANT</div>
        </div>
      </div>
    `;
    colony.appendChild(col);
    applyPersonaColor(p.id, p.color);
  });
}

export function buildTargetButtons() {
  const container = document.getElementById('targetButtons');
  container.innerHTML = '';
  PERSONAS.forEach(p => {
    const label = state.config[p.id].name || p.name;
    const btn = document.createElement('button');
    btn.className = 'target-btn';
    btn.dataset.target = p.id;
    btn.textContent = label;
    if (state.selectedTargets.has(p.id)) btn.classList.add('selected');
    container.appendChild(btn);
  });
  const allBtn = document.createElement('button');
  allBtn.className = 'target-btn all-btn';
  allBtn.dataset.target = 'ALL';
  allBtn.textContent = 'ALL';
  if (state.selectedTargets.has('ALL')) allBtn.classList.add('selected');
  container.appendChild(allBtn);
  PERSONAS.forEach(p => {
    const color = state.config[p.id].color || p.color;
    applyPersonaColor(p.id, color);
  });
}
