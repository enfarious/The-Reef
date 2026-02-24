'use strict';

// ─── Built-in tool display list ───────────────────────────────────────────────
// Display metadata only — execution config lives in renderer.js TOOL_DEFS.
// Keep in sync when adding/removing tools.

const BUILTIN_TOOLS = [
  { name: 'fs_read',         description: 'Read a file and return its text contents.' },
  { name: 'fs_write',        description: 'Write content to a file.' },
  { name: 'fs_delete',       description: 'Delete a file. Always requires user confirmation.' },
  { name: 'fs_list',         description: 'List directory contents.' },
  { name: 'fs_exists',       description: 'Check if a path exists.' },
  { name: 'shell_run',       description: 'Execute a shell command.' },
  { name: 'clipboard_read',  description: 'Read the current clipboard text.' },
  { name: 'clipboard_write', description: 'Write text to the clipboard.' },
  { name: 'memory_save',     description: 'Save a memory to the collective colony memory pool.' },
  { name: 'memory_search',   description: 'Search the collective colony memory pool.' },
  { name: 'memory_link',     description: 'Create a directed association between two memories.' },
  { name: 'reef_post',       description: 'Post an entry to The Reef documentation site.' },
  { name: 'reef_get',        description: 'Retrieve an entry from The Reef by its entry ID.' },
  { name: 'reef_list',       description: 'List or search entries on The Reef.' },
  { name: 'message_send',    description: 'Send a message to another colony member.' },
  { name: 'message_inbox',   description: 'Read messages from your colony inbox.' },
  { name: 'message_reply',   description: 'Reply to a colony message.' },
  { name: 'message_search',  description: 'Search the colony message history.' },
  { name: 'colony_ask',      description: 'Send a question or directive to another colony member.' },
];

// ─── Text color presets ───────────────────────────────────────────────────────

const TEXT_COLOR_PRESETS = [
  { id: 'cool',  label: 'COOL',  bright: '#e8f4f8', mid: '#7fa8c0', dim: '#3a5870' },
  { id: 'warm',  label: 'WARM',  bright: '#f5ede0', mid: '#c09768', dim: '#6b4a2a' },
  { id: 'mono',  label: 'MONO',  bright: '#e8e8e8', mid: '#909090', dim: '#484848' },
  { id: 'green', label: 'GREEN', bright: '#c0f0c0', mid: '#52a052', dim: '#285028' },
  { id: 'amber', label: 'AMBER', bright: '#f5e0a0', mid: '#c09040', dim: '#6b4a18' },
];

// ─── State ────────────────────────────────────────────────────────────────────
// loadedCfg holds the full config from disk.  Only cfg.settings is mutated
// here; A/B/C/global sections are preserved and re-saved unchanged.

let loadedCfg = {};

// ─── Tab switching ────────────────────────────────────────────────────────────

document.querySelectorAll('.sw-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.sw-tab').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.sw-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
  });
});

// ─── Save ─────────────────────────────────────────────────────────────────────

let saveTimer = null;

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 600);
}

async function save() {
  const cfg = { ...loadedCfg, settings: buildSettings() };
  await window.reef.saveConfig(cfg);
}

function buildSettings() {
  const s = loadedCfg.settings || {};
  return {
    reefUrl:           val('sReefUrl'),
    reefApiKey:        val('sReefApiKey'),
    colonyName:        val('sColonyName'),
    baseSystemPrompt:  val('sBasePrompt'),
    fontScale:         parseInt(document.getElementById('sFontScale').value, 10) || 100,
    fontColors:        s.fontColors || 'cool',       // managed via swatch clicks
    operatorName:      val('sOperatorName'),
    operatorBirthdate: val('sOperatorBirthdate'),
    operatorAbout:     val('sOperatorAbout'),
    heartbeatInterval: Math.max(5, parseInt(val('sHeartbeatInterval'), 10) || 60),
    toolStates:        s.toolStates  || {},
    customTools:       s.customTools || [],
    cwd:               s.cwd         || null,
  };
}

function val(id) { return document.getElementById(id)?.value ?? ''; }

// ─── Populate fields on load ──────────────────────────────────────────────────

function populate(cfg) {
  const s = cfg.settings || {};
  set('sColonyName',        s.colonyName        || '');
  set('sBasePrompt',        s.baseSystemPrompt  || '');
  set('sHeartbeatInterval', s.heartbeatInterval || 60);
  set('sReefUrl',           s.reefUrl           || '');
  set('sReefApiKey',        s.reefApiKey        || '');
  set('sOperatorName',      s.operatorName      || '');
  set('sOperatorBirthdate', s.operatorBirthdate || '');
  set('sOperatorAbout',     s.operatorAbout     || '');
  setFontScale(s.fontScale  || 100);
  buildColorPalette(s.fontColors || 'cool');
  buildToolsList();
}

function set(id, value) {
  const el = document.getElementById(id);
  if (el) el.value = value;
}

// ─── Font scale ───────────────────────────────────────────────────────────────

function setFontScale(v) {
  document.getElementById('sFontScale').value = v;
  document.getElementById('sFontScaleVal').textContent = v + '%';
}

document.getElementById('sFontScale').addEventListener('input', e => {
  const v = parseInt(e.target.value, 10);
  document.getElementById('sFontScaleVal').textContent = v + '%';
  if (!loadedCfg.settings) loadedCfg.settings = {};
  loadedCfg.settings.fontScale = v;
  scheduleSave();
});

// ─── Text color palette ───────────────────────────────────────────────────────

function buildColorPalette(activeId) {
  const palette = document.getElementById('sColorPalette');
  if (!palette) return;
  palette.innerHTML = '';
  TEXT_COLOR_PRESETS.forEach(preset => {
    const btn = document.createElement('button');
    btn.className = 'sw-color-swatch' + (preset.id === activeId ? ' active' : '');
    btn.dataset.colorId = preset.id;
    btn.innerHTML = `
      <span class="sw-swatch-preview" style="color:${preset.bright}">Aa</span>
      <span class="sw-swatch-label">${preset.label}</span>
    `;
    btn.addEventListener('click', () => {
      document.querySelectorAll('.sw-color-swatch').forEach(s => s.classList.remove('active'));
      btn.classList.add('active');
      if (!loadedCfg.settings) loadedCfg.settings = {};
      loadedCfg.settings.fontColors = preset.id;
      scheduleSave();
    });
    palette.appendChild(btn);
  });
}

// ─── Tools list ───────────────────────────────────────────────────────────────

function buildToolsList() {
  const container = document.getElementById('swToolsList');
  if (!container) return;
  container.innerHTML = '';

  const s           = loadedCfg.settings || {};
  const toolStates  = s.toolStates  || {};
  const customTools = s.customTools || [];

  const allTools = [
    ...BUILTIN_TOOLS.map(t => ({ ...t, _builtin: true })),
    ...customTools.map(t => ({ ...t, _builtin: false })),
  ];

  allTools.forEach(tool => {
    const enabled = toolStates[tool.name] !== false;
    const row = document.createElement('div');
    row.className = 'sw-tool-row';
    row.innerHTML = `
      <label class="sw-tool-toggle" title="${enabled ? 'Disable' : 'Enable'}">
        <input type="checkbox" ${enabled ? 'checked' : ''} data-tool-toggle="${esc(tool.name)}">
        <span class="sw-tool-track"></span>
      </label>
      <div class="sw-tool-info">
        <span class="sw-tool-name">${esc(tool.name)}</span>
        <span class="sw-tool-desc" title="${esc(tool.description)}">${esc(tool.description)}</span>
      </div>
      ${tool._builtin
        ? '<span class="sw-tool-badge">BUILT-IN</span>'
        : `<button class="sw-tool-delete" data-tool-delete="${esc(tool.name)}">✕</button>`}
    `;

    row.querySelector('[data-tool-toggle]').addEventListener('change', e => {
      if (!loadedCfg.settings) loadedCfg.settings = {};
      if (!loadedCfg.settings.toolStates) loadedCfg.settings.toolStates = {};
      loadedCfg.settings.toolStates[e.target.dataset.toolToggle] = e.target.checked;
      scheduleSave();
    });

    const del = row.querySelector('[data-tool-delete]');
    if (del) {
      del.addEventListener('click', () => {
        const n = del.dataset.toolDelete;
        if (!loadedCfg.settings) loadedCfg.settings = {};
        loadedCfg.settings.customTools = (loadedCfg.settings.customTools || []).filter(t => t.name !== n);
        if (loadedCfg.settings.toolStates) delete loadedCfg.settings.toolStates[n];
        buildToolsList();
        scheduleSave();
      });
    }

    container.appendChild(row);
  });
}

// ─── Tool import ──────────────────────────────────────────────────────────────

document.getElementById('swToolImportBtn').addEventListener('click', () => {
  document.getElementById('swToolImportArea').classList.add('open');
  document.getElementById('swToolImportBtn').style.display = 'none';
  document.getElementById('swToolImportJson').focus();
});

document.getElementById('swToolImportCancel').addEventListener('click', () => {
  document.getElementById('swToolImportArea').classList.remove('open');
  document.getElementById('swToolImportBtn').style.display = '';
  document.getElementById('swToolImportJson').value = '';
  document.getElementById('swToolImportJson').classList.remove('error');
});

document.getElementById('swToolImportConfirm').addEventListener('click', () => {
  const ta  = document.getElementById('swToolImportJson');
  const raw = ta.value.trim();
  let tool;
  try { tool = JSON.parse(raw); } catch { flash(ta); return; }

  if (!tool.name || !tool.description || !tool.input_schema || typeof tool.input_schema !== 'object') {
    flash(ta); return;
  }

  const builtinNames = BUILTIN_TOOLS.map(t => t.name);
  const customNames  = (loadedCfg.settings?.customTools || []).map(t => t.name);
  if ([...builtinNames, ...customNames].includes(tool.name)) { flash(ta); return; }

  if (!loadedCfg.settings) loadedCfg.settings = {};
  loadedCfg.settings.customTools = [
    ...(loadedCfg.settings.customTools || []),
    { name: tool.name, description: tool.description, input_schema: tool.input_schema,
      ...(tool.endpoint ? { endpoint: tool.endpoint } : {}) },
  ];

  ta.value = '';
  document.getElementById('swToolImportArea').classList.remove('open');
  document.getElementById('swToolImportBtn').style.display = '';
  buildToolsList();
  scheduleSave();
});

function flash(el) {
  el.classList.add('error');
  setTimeout(() => el.classList.remove('error'), 1400);
}

// ─── Field change listeners ───────────────────────────────────────────────────

['sColonyName', 'sBasePrompt', 'sReefUrl', 'sReefApiKey',
 'sOperatorName', 'sOperatorBirthdate', 'sOperatorAbout'].forEach(id => {
  document.getElementById(id).addEventListener('input', scheduleSave);
});

document.getElementById('sHeartbeatInterval').addEventListener('change', e => {
  const mins = Math.max(5, parseInt(e.target.value, 10) || 60);
  e.target.value = mins;
  scheduleSave();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  const result = await window.reef.loadConfig();
  loadedCfg = result || {};
  populate(loadedCfg);
}

init();
