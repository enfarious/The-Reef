// ─── Config auto-save, apply, and input listeners ────────────────────────────

import { PERSONAS, state } from './state.js';
import { resizeTextarea } from './utils.js';
import { applyFontScale, applyTextColors, applyColonyName, applyPersonaColor } from './color.js';
import { buildTargetButtons } from './colony-ui.js';
import { updateContextCounter, updateCwdDisplay, scanProject } from './context.js';

export function collectConfig() {
  const cycleNum = document.getElementById('cycleNumber').value.trim() || '001';
  const cfg = { global: { cycle: 'CYCLE_' + cycleNum } };
  PERSONAS.forEach(p => {
    const endpointEl    = document.getElementById(`endpoint-${p.id}`);
    const rawEndpoint   = endpointEl.value;
    const isCliProxy    = endpointEl.dataset.claudeCli === '1';
    const endpointToSave = isCliProxy ? 'claude-cli' : rawEndpoint;
    cfg[p.id] = {
      endpoint:     endpointToSave,
      model:        document.getElementById(`model-${p.id}`).value,
      systemPrompt: state.config[p.id].systemPrompt || '',
      apiKey:       document.getElementById(`apikey-${p.id}`).value,
      reefApiKey:   state.config[p.id].reefApiKey || '',
      name:  state.config[p.id].name  || '',
      role:  state.config[p.id].role  || '',
      color: state.config[p.id].color || '',
    };
  });
  cfg.global.apiKey = document.getElementById('globalApiKey').value;
  cfg.settings = { ...state.config.settings, cwd: state.cwd || null };
  if (state.config.database) cfg.database = state.config.database;
  return cfg;
}

let saveTimer = null;
export function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await window.reef.saveConfig(collectConfig());
  }, 800);
}

export function applyConfig(cfg) {
  if (!cfg) return;
  if (cfg.database) state.config.database = cfg.database;
  if (cfg.global) {
    if (cfg.global.cycle) document.getElementById('cycleNumber').value = cfg.global.cycle.replace(/^CYCLE_/i, '');
    if (cfg.global.apiKey) document.getElementById('globalApiKey').value = cfg.global.apiKey;
  }
  if (cfg.settings) {
    state.config.settings = { ...state.config.settings, ...cfg.settings };
    if (cfg.settings.fontScale  !== undefined) applyFontScale(cfg.settings.fontScale);
    if (cfg.settings.fontColors !== undefined) applyTextColors(cfg.settings.fontColors);
    applyColonyName(state.config.settings.colonyName);
    if (cfg.settings.cwd) {
      state.cwd = cfg.settings.cwd;
      updateCwdDisplay();
      scanProject(cfg.settings.cwd);
    }
  }
  PERSONAS.forEach(p => {
    const pc = cfg[p.id];
    if (!pc) return;
    if (pc.endpoint) {
      const isCli = pc.endpoint === 'claude-cli';
      const input = document.getElementById(`endpoint-${p.id}`);
      if (isCli) {
        // Resolve to proxy URL if available; otherwise leave blank with
        // a placeholder — resolveClaudeCliEndpoints() fills it in once
        // the proxy info arrives.  Never put the literal 'claude-cli'
        // string into the input value (it's not a valid URL).
        input.value       = state.claudeProxyEndpoint || '';
        input.placeholder = state.claudeProxyEndpoint ? '' : 'claude-cli (waiting for proxy\u2026)';
        input.dataset.claudeCli = '1';
      } else {
        input.value       = pc.endpoint;
        input.placeholder = '';
        input.dataset.claudeCli = '';
      }
    }
    if (pc.model)        document.getElementById(`model-${p.id}`).value       = pc.model;
    if (pc.systemPrompt) state.config[p.id].systemPrompt = pc.systemPrompt;
    if (pc.apiKey)       document.getElementById(`apikey-${p.id}`).value      = pc.apiKey;
    if (pc.reefApiKey)   state.config[p.id].reefApiKey = pc.reefApiKey;
    if (pc.name) {
      state.config[p.id].name = pc.name;
      const el = document.getElementById(`name-${p.id}`);
      if (el) el.textContent = pc.name;
    }
    if (pc.role) {
      state.config[p.id].role = pc.role;
      const el = document.getElementById(`role-${p.id}`);
      if (el) el.textContent = pc.role;
    }
    if (pc.color) {
      state.config[p.id].color = pc.color;
      applyPersonaColor(p.id, pc.color);
    }
  });
  buildTargetButtons();
}

// ─── DOM input/change listeners for auto-save ─────────────────────────────────

export function initConfigListeners() {
  document.addEventListener('input', e => {
    if (
      e.target.matches('.endpoint-input') ||
      e.target.matches('.api-key-input') ||
      e.target.matches('#globalApiKey')
    ) {
      scheduleSave();
    }
    if (e.target.matches('.endpoint-input')) {
      const col = e.target.closest('[data-persona]');
      if (col) state.lastResponseId[col.dataset.persona] = null;
    }
    if (e.target.id === 'userInput') resizeTextarea(e.target);
  });

  document.addEventListener('change', e => {
    if (e.target.matches('.model-select')) {
      scheduleSave();
      const col = e.target.closest('[data-persona]');
      if (col) {
        const pid = col.dataset.persona;
        const m   = (state.modelList[pid] || []).find(x => x.id === e.target.value);
        state.maxContext[pid] = m?.maxContext ?? null;
        updateContextCounter(pid);
      }
    }
    if (e.target.id === 'cycleNumber') scheduleSave();
  });
}
