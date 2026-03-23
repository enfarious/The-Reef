// ─── Modals & flyouts — entity settings, reef post, confirmation ─────────────

import { PERSONAS, state } from './state.js';
import { escHtml, slugify } from './utils.js';
import { COLOR_PALETTE, applyPersonaColor } from './color.js';
import { buildTargetButtons } from './colony-ui.js';
import { scheduleSave } from './config.js';
import { appendError } from './messages-ui.js';
import { TOOL_DEFS } from './tools.js';

// ─── Tool categories for the agent tools grid ────────────────────────────────
const TOOL_CATEGORIES = {
  'Filesystem':  ['fs_read', 'fs_write', 'fs_delete', 'fs_list', 'fs_exists'],
  'Code & Git':  ['code_search', 'project_scan', 'shell_run', 'git_status', 'git_diff', 'git_log', 'git_commit', 'git_branch', 'git_push'],
  'Memory':      ['memory_save', 'memory_search', 'memory_link', 'ecology_monitor', 'memory_dedupe', 'broker_remember', 'broker_recall', 'graph_recall', 'graph_add_node', 'graph_add_edge', 'graph_consolidate', 'graph_arbitrate', 'graph_decay_pass', 'working_memory_write', 'working_memory_read'],
  'Colony':      ['message_send', 'message_inbox', 'message_reply', 'message_search', 'colony_ask', 'vote_propose', 'vote_cast', 'vote_table', 'vote_comment', 'vote_list', 'vote_detail'],
  'Reef & Web':  ['reef_post', 'reef_get', 'reef_list', 'web_search', 'http_request', 'reddit_search', 'reddit_hot', 'reddit_post'],
  'System':      ['clipboard_read', 'clipboard_write', 'vision_screenshot', 'vision_read_image', 'notify', 'schedule_task', 'schedule_list', 'schedule_cancel'],
};

function buildToolsGrid(container, enabledTools) {
  container.innerHTML = '';
  // null = all enabled (default)
  const allEnabled = enabledTools === null;
  const enabledSet = allEnabled ? null : new Set(enabledTools);

  for (const [category, toolNames] of Object.entries(TOOL_CATEGORIES)) {
    const catLabel = document.createElement('div');
    catLabel.className = 'agent-tools-category';
    catLabel.textContent = category;
    container.appendChild(catLabel);

    for (const name of toolNames) {
      const def = TOOL_DEFS.find(t => t.name === name);
      if (!def) continue;
      const label = document.createElement('label');
      label.className = 'agent-tool-checkbox';
      const checked = allEnabled || enabledSet.has(name);
      label.innerHTML = `<input type="checkbox" value="${name}" ${checked ? 'checked' : ''}> <span>${name}</span>`;
      container.appendChild(label);
    }
  }
}

function readToolsGrid(container) {
  const checkboxes = container.querySelectorAll('input[type="checkbox"]');
  const allChecked = [...checkboxes].every(cb => cb.checked);
  if (allChecked) return null; // null = all enabled (default)
  return [...checkboxes].filter(cb => cb.checked).map(cb => cb.value);
}

// ─── Entity settings flyout ──────────────────────────────────────────────────

let entitySettingsPersonaId = null;

export function openEntitySettings(personaId, triggerEl) {
  entitySettingsPersonaId = personaId;
  const p   = PERSONAS.find(q => q.id === personaId);
  const cfg = state.config[personaId];

  document.getElementById('entitySettingsTitle').textContent =
    (cfg.name || p.name) + ' — SETTINGS';
  document.getElementById('entityName').value         = cfg.name  || p.name;
  document.getElementById('entityRole').value         = cfg.role  || p.role;
  document.getElementById('entityMemoryDepth').value  = cfg.memoryDepth != null ? cfg.memoryDepth : 10;
  document.getElementById('entityHeartbeat').checked      = cfg.heartbeat !== false;
  document.getElementById('entityDreamProducer').checked   = cfg.dreamProducer === true;
  document.getElementById('entityDreamReceiver').checked   = cfg.dreamReceiver !== false;
  document.getElementById('entityHeartbeatPrompt').value   = cfg.heartbeatPrompt || '';
  document.getElementById('entityReefApiKey').value   = cfg.reefApiKey || '';
  document.getElementById('entitySystemPrompt').value = cfg.systemPrompt || p.systemPrompt || '';

  // Build color swatches
  const currentColor = cfg.color || p.color;
  const palette      = document.getElementById('entityColorPalette');
  palette.innerHTML  = '';
  COLOR_PALETTE.forEach(c => {
    const sw = document.createElement('button');
    sw.className = 'color-swatch' + (c.hex.toLowerCase() === currentColor.toLowerCase() ? ' active' : '');
    sw.dataset.color = c.hex;
    sw.style.background = c.hex;
    sw.title = c.name;
    sw.addEventListener('click', () => {
      palette.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('active'));
      sw.classList.add('active');
      state.config[personaId].color = c.hex;
      applyPersonaColor(personaId, c.hex);
      scheduleSave();
    });
    palette.appendChild(sw);
  });

  // Position the dropdown near the trigger button
  const flyout = document.getElementById('entitySettingsFlyout');
  flyout.classList.add('open');
  document.getElementById('entitySettingsBackdrop').classList.add('visible');

  if (triggerEl) {
    const rect    = triggerEl.getBoundingClientRect();
    const PADDING = 8;
    const W       = 300;
    let top  = rect.bottom + 4;
    let left = rect.right - W;
    if (left < PADDING) left = PADDING;
    const maxH = window.innerHeight * 0.88;
    if (top + maxH > window.innerHeight - PADDING) top = rect.top - maxH - 4;
    if (top < PADDING) top = PADDING;
    flyout.style.top  = top  + 'px';
    flyout.style.left = left + 'px';
  }
}

export function closeEntitySettings() {
  document.getElementById('entitySettingsFlyout').classList.remove('open');
  document.getElementById('entitySettingsBackdrop').classList.remove('visible');
  entitySettingsPersonaId = null;
}


// ─── Confirmation modal ──────────────────────────────────────────────────────

export function initConfirmModal() {
  window.reef.onConfirmRequest((id, message) => {
    const overlay = document.getElementById('confirmOverlay');
    document.getElementById('confirmMessage').textContent = message;
    overlay.style.display = 'flex';

    function respond(approved) {
      overlay.style.display = 'none';
      window.reef.respondConfirm(id, approved);
    }

    document.getElementById('confirmOk').onclick     = () => respond(true);
    document.getElementById('confirmCancel').onclick  = () => respond(false);
  });
}

// ─── Agent picker ─────────────────────────────────────────────────────────────

let agentPickerPersonaId = null;

export function openAgentPicker(personaId, triggerEl) {
  agentPickerPersonaId = personaId;
  const p   = PERSONAS.find(q => q.id === personaId);
  const cfg = state.config[personaId];

  document.getElementById('agentPickerTitle').textContent =
    (cfg.name || p.name) + ' — SWITCH AGENT';

  // Build the list
  const list = document.getElementById('agentPickerList');
  list.innerHTML = '';

  // Default personas section
  const defaultLabel = document.createElement('div');
  defaultLabel.className = 'agent-picker-section-label';
  defaultLabel.textContent = 'DEFAULT PERSONAS';
  list.appendChild(defaultLabel);

  PERSONAS.forEach(dp => {
    const item = document.createElement('button');
    item.className = 'agent-picker-item';
    if (!cfg.activeAgent && dp.id === personaId) item.classList.add('active');
    const dot = `<span class="agent-picker-dot" style="background:${dp.color}"></span>`;
    item.innerHTML = `${dot}<span class="agent-picker-item-name">${escHtml(dp.name)}</span><span class="agent-picker-item-role">${escHtml(dp.role)}</span>`;
    item.addEventListener('click', () => {
      // Preserve claude-cli proxy if the column is currently using it
      const currentInput = document.getElementById(`endpoint-${personaId}`);
      const keepCli = currentInput && currentInput.dataset.claudeCli === '1';
      applyAgentToColumn(personaId, {
        name: '',   // empty = use default persona name
        role: '',
        color: dp.color,
        systemPrompt: dp.systemPrompt,
        heartbeatPrompt: '',  // empty = use built-in default
        model: dp.defaultModel,
        endpoint: keepCli ? 'claude-cli' : dp.defaultEndpoint,
        memoryDepth: 10,
        heartbeat: true,
        dreamProducer: dp.id === 'C',   // Librarian produces by default
        dreamReceiver: dp.id !== 'C',   // others receive by default
        tools: null,
      }, null);
      closeAgentPicker();
    });
    list.appendChild(item);
  });

  // Custom agents section
  const agents = state.config.agents || [];
  if (agents.length) {
    const customLabel = document.createElement('div');
    customLabel.className = 'agent-picker-section-label';
    customLabel.textContent = 'SAVED AGENTS';
    list.appendChild(customLabel);

    agents.forEach(agent => {
      const item = document.createElement('button');
      item.className = 'agent-picker-item';
      if (cfg.activeAgent === agent.id) item.classList.add('active');
      const dot = `<span class="agent-picker-dot" style="background:${agent.color || '#888'}"></span>`;
      const depth = agent.memoryDepth != null ? agent.memoryDepth : 10;
      item.innerHTML = `${dot}<span class="agent-picker-item-name">${escHtml(agent.name)}</span><span class="agent-picker-item-role">${escHtml(agent.role || '')}</span><span class="agent-picker-item-depth" title="Memory depth">${depth}◈</span><button class="agent-picker-delete" data-agent-id="${agent.id}" title="Delete agent">✕</button>`;
      item.addEventListener('click', (e) => {
        if (e.target.classList.contains('agent-picker-delete')) return;
        applyAgentToColumn(personaId, agent, agent.id);
        closeAgentPicker();
      });
      list.appendChild(item);
    });

    // Delete handlers
    list.querySelectorAll('.agent-picker-delete').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const agentId = btn.dataset.agentId;
        state.config.agents = state.config.agents.filter(a => a.id !== agentId);
        // If this agent was active on any column, clear it
        PERSONAS.forEach(pp => {
          if (state.config[pp.id].activeAgent === agentId) {
            state.config[pp.id].activeAgent = null;
          }
        });
        scheduleSave();
        openAgentPicker(personaId, triggerEl); // refresh
      });
    });
  }

  // Position
  const flyout = document.getElementById('agentPickerFlyout');
  flyout.classList.add('open');
  document.getElementById('agentPickerBackdrop').classList.add('visible');

  if (triggerEl) {
    const rect    = triggerEl.getBoundingClientRect();
    const PADDING = 8;
    const W       = 280;
    let top  = rect.bottom + 4;
    let left = rect.right - W;
    if (left < PADDING) left = PADDING;
    const maxH = window.innerHeight * 0.7;
    if (top + maxH > window.innerHeight - PADDING) top = rect.top - maxH - 4;
    if (top < PADDING) top = PADDING;
    flyout.style.top  = top  + 'px';
    flyout.style.left = left + 'px';
  }
}

export function closeAgentPicker() {
  document.getElementById('agentPickerFlyout').classList.remove('open');
  document.getElementById('agentPickerBackdrop').classList.remove('visible');
  agentPickerPersonaId = null;
}

function applyAgentToColumn(personaId, agent, agentId) {
  const cfg = state.config[personaId];
  cfg.activeAgent     = agentId;
  cfg.name            = agent.name || '';
  cfg.role            = agent.role || '';
  cfg.color           = agent.color || '';
  cfg.systemPrompt    = agent.systemPrompt || '';
  cfg.heartbeatPrompt = agent.heartbeatPrompt || '';
  cfg.memoryDepth     = agent.memoryDepth != null ? agent.memoryDepth : 10;
  cfg.heartbeat       = agent.heartbeat !== false;
  cfg.dreamProducer   = agent.dreamProducer === true;
  cfg.dreamReceiver   = agent.dreamReceiver !== false;
  cfg.tools           = agent.tools || null;

  // Apply model + endpoint if provided
  if (agent.model)    document.getElementById(`model-${personaId}`).value    = agent.model;
  if (agent.endpoint) {
    const input = document.getElementById(`endpoint-${personaId}`);
    const isCli = agent.endpoint === 'claude-cli';
    if (isCli) {
      // Resolve to live proxy URL, same as config.js applyConfig
      input.value       = state.claudeProxyEndpoint || '';
      input.placeholder = state.claudeProxyEndpoint ? '' : 'claude-cli (waiting for proxy…)';
      input.dataset.claudeCli = '1';
      if (state.claudeProxyEndpoint) {
        input.title = `Claude CLI OAuth proxy — ${state.claudeProxyEndpoint}`;
        input.classList.add('oauth-proxy-active');
      }
    } else {
      input.value = agent.endpoint;
      input.dataset.claudeCli = '';
      input.title = '';
      input.classList.remove('oauth-proxy-active');
    }
  }

  // Update UI
  const nameEl = document.getElementById(`name-${personaId}`);
  const roleEl = document.getElementById(`role-${personaId}`);
  const p = PERSONAS.find(q => q.id === personaId);
  if (nameEl) nameEl.textContent = agent.name || p.name;
  if (roleEl) roleEl.textContent = agent.role || p.role;
  applyPersonaColor(personaId, agent.color || p.color);
  buildTargetButtons();
  scheduleSave();
}

export function initAgentPickerListeners() {
  document.getElementById('agentPickerClose').addEventListener('click', closeAgentPicker);
  document.getElementById('agentPickerBackdrop').addEventListener('click', closeAgentPicker);

  // Save current as agent
  document.getElementById('agentSaveCurrentBtn').addEventListener('click', () => {
    const pid = agentPickerPersonaId || 'A';
    closeAgentPicker();
    openSaveAgentModal(pid);
  });
}

function openSaveAgentModal(personaId) {
  const p   = PERSONAS.find(q => q.id === personaId);
  const cfg = state.config[personaId];

  document.getElementById('saveAgentName').value         = cfg.name || p.name;
  document.getElementById('saveAgentRole').value         = cfg.role || p.role;
  document.getElementById('saveAgentMemoryDepth').value  = cfg.memoryDepth != null ? cfg.memoryDepth : 10;
  document.getElementById('saveAgentHeartbeat').checked   = cfg.heartbeat !== false;
  buildToolsGrid(document.getElementById('saveAgentTools'), cfg.tools || null);
  document.getElementById('saveAgentSystemPrompt').value     = cfg.systemPrompt || p.systemPrompt || '';
  document.getElementById('saveAgentHeartbeatPrompt').value  = cfg.heartbeatPrompt || '';
  document.getElementById('saveAgentDreamProducer').checked  = cfg.dreamProducer === true;
  document.getElementById('saveAgentDreamReceiver').checked  = cfg.dreamReceiver !== false;
  document.getElementById('saveAgentStatus').textContent = '';

  const overlay = document.getElementById('saveAgentOverlay');
  overlay.style.display = 'flex';

  document.getElementById('saveAgentCancel').onclick = () => {
    overlay.style.display = 'none';
  };

  document.getElementById('saveAgentSubmit').onclick = () => {
    const name  = document.getElementById('saveAgentName').value.trim().toUpperCase();
    const role  = document.getElementById('saveAgentRole').value.trim();
    const depth = parseInt(document.getElementById('saveAgentMemoryDepth').value, 10) || 0;
    const prompt = document.getElementById('saveAgentSystemPrompt').value.trim();

    if (!name) {
      document.getElementById('saveAgentStatus').textContent = 'Agent name is required.';
      document.getElementById('saveAgentStatus').style.color = 'rgba(255,100,100,0.8)';
      return;
    }

    const endpointInput = document.getElementById(`endpoint-${personaId}`);
    const endpointToSave = endpointInput.dataset.claudeCli === '1' ? 'claude-cli' : endpointInput.value;

    const hbPrompt = document.getElementById('saveAgentHeartbeatPrompt').value.trim();

    const agent = {
      id:              'agent-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name,
      role,
      color:           cfg.color || p.color,
      systemPrompt:    prompt,
      heartbeatPrompt: hbPrompt || '',
      model:           document.getElementById(`model-${personaId}`).value,
      endpoint:        endpointToSave,
      memoryDepth:     Math.max(0, Math.min(20, depth)),
      heartbeat:       document.getElementById('saveAgentHeartbeat').checked,
      dreamProducer:   document.getElementById('saveAgentDreamProducer').checked,
      dreamReceiver:   document.getElementById('saveAgentDreamReceiver').checked,
      tools:           readToolsGrid(document.getElementById('saveAgentTools')),
    };

    if (!state.config.agents) state.config.agents = [];
    state.config.agents.push(agent);
    scheduleSave();

    overlay.style.display = 'none';
  };
}

// ─── Entity settings live-update listeners ───────────────────────────────────

export function initEntitySettingsListeners() {
  document.getElementById('entitySettingsClose').addEventListener('click', closeEntitySettings);
  document.getElementById('entitySettingsBackdrop').addEventListener('click', closeEntitySettings);

  document.getElementById('entityName').addEventListener('input', e => {
    if (!entitySettingsPersonaId) return;
    const name = e.target.value.toUpperCase();
    state.config[entitySettingsPersonaId].name = name;
    const nameEl = document.getElementById(`name-${entitySettingsPersonaId}`);
    if (nameEl) nameEl.textContent = name;
    document.getElementById('entitySettingsTitle').textContent = name + ' — SETTINGS';
    buildTargetButtons();
    scheduleSave();
  });

  document.getElementById('entityRole').addEventListener('input', e => {
    if (!entitySettingsPersonaId) return;
    state.config[entitySettingsPersonaId].role = e.target.value;
    const roleEl = document.getElementById(`role-${entitySettingsPersonaId}`);
    if (roleEl) roleEl.textContent = e.target.value;
    scheduleSave();
  });

  document.getElementById('entityMemoryDepth').addEventListener('input', e => {
    if (!entitySettingsPersonaId) return;
    const val = parseInt(e.target.value, 10);
    state.config[entitySettingsPersonaId].memoryDepth = isNaN(val) ? 10 : Math.max(0, Math.min(20, val));
    scheduleSave();
  });

  document.getElementById('entityHeartbeat').addEventListener('change', e => {
    if (!entitySettingsPersonaId) return;
    state.config[entitySettingsPersonaId].heartbeat = e.target.checked;
    scheduleSave();
  });

  document.getElementById('entityDreamProducer').addEventListener('change', e => {
    if (!entitySettingsPersonaId) return;
    state.config[entitySettingsPersonaId].dreamProducer = e.target.checked;
    scheduleSave();
  });

  document.getElementById('entityDreamReceiver').addEventListener('change', e => {
    if (!entitySettingsPersonaId) return;
    state.config[entitySettingsPersonaId].dreamReceiver = e.target.checked;
    scheduleSave();
  });

  document.getElementById('entityHeartbeatPrompt').addEventListener('input', e => {
    if (!entitySettingsPersonaId) return;
    state.config[entitySettingsPersonaId].heartbeatPrompt = e.target.value;
    scheduleSave();
  });

  document.getElementById('entityReefApiKey').addEventListener('input', e => {
    if (!entitySettingsPersonaId) return;
    state.config[entitySettingsPersonaId].reefApiKey = e.target.value;
    scheduleSave();
  });

  document.getElementById('entitySystemPrompt').addEventListener('input', e => {
    if (!entitySettingsPersonaId) return;
    state.config[entitySettingsPersonaId].systemPrompt = e.target.value;
    scheduleSave();
  });
}
