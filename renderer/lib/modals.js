// ─── Modals & flyouts — entity settings, reef post, confirmation ─────────────

import { PERSONAS, state } from './state.js';
import { escHtml, slugify } from './utils.js';
import { COLOR_PALETTE, applyPersonaColor } from './color.js';
import { buildTargetButtons } from './colony-ui.js';
import { scheduleSave } from './config.js';
import { appendError } from './messages-ui.js';

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

// ─── Reef post modal ─────────────────────────────────────────────────────────

export function openReefPost(personaId) {
  const lastMsg = [...state.conversations[personaId]].reverse().find(m => m.role === 'assistant');
  if (!lastMsg) {
    appendError(personaId, 'No assistant message to post yet.');
    return;
  }

  const persona     = PERSONAS.find(p => p.id === personaId);
  const personaName = state.config[personaId].name || persona.name;
  const cycle = 'CYCLE_' + (document.getElementById('cycleNumber').value.trim() || '001');
  const defaultTitle = `${personaName} — ${new Date().toISOString().slice(0, 10)}`;

  const titleEl   = document.getElementById('reefTitle');
  const entryIdEl = document.getElementById('reefEntryId');
  const cycleEl   = document.getElementById('reefCycle');
  const tagsEl    = document.getElementById('reefTags');
  const apiKeyEl  = document.getElementById('reefApiKeyModal');
  const previewEl = document.getElementById('reefPreview');
  const statusEl  = document.getElementById('reefPostStatus');

  titleEl.value   = defaultTitle;
  entryIdEl.value = slugify(defaultTitle);
  cycleEl.value   = cycle;
  tagsEl.value    = [personaName.toLowerCase(), 'colony'].join(', ');
  apiKeyEl.value  = state.config[personaId].reefApiKey
    || state.config.settings.reefApiKey
    || '';
  previewEl.textContent = lastMsg.content.slice(0, 300) + (lastMsg.content.length > 300 ? '…' : '');
  statusEl.textContent  = '';

  titleEl.oninput = () => {
    entryIdEl.value = slugify(titleEl.value);
  };

  const overlay = document.getElementById('reefPostOverlay');
  overlay.style.display = 'flex';

  document.getElementById('reefPostCancel').onclick = () => {
    overlay.style.display = 'none';
  };

  document.getElementById('reefPostSubmit').onclick = async () => {
    const apiKey  = apiKeyEl.value.trim();
    const title   = titleEl.value.trim();
    const entryId = entryIdEl.value.trim();
    const cyclVal = cycleEl.value.trim();
    const tags    = tagsEl.value.split(',').map(t => t.trim()).filter(Boolean);

    if (!title || !entryId || !cyclVal) {
      statusEl.textContent = 'Title, entry ID, and cycle are required.';
      statusEl.style.color = 'rgba(255,100,100,0.8)';
      return;
    }

    statusEl.textContent = 'Posting…';
    statusEl.style.color = 'var(--text-dim)';

    const result = await window.reef.invoke('reef.post', {
      entryId,
      title,
      content: lastMsg.content,
      authorName: personaName,
      cycle: cyclVal,
      tags,
      linkedIds: [],
      apiKey,
      baseUrl: state.config.settings.reefUrl || undefined,
    });

    if (!result.ok) {
      statusEl.textContent = `Error: ${result.error}`;
      statusEl.style.color = 'rgba(255,100,100,0.8)';
      return;
    }

    if (state.config[personaId].reefApiKey) {
      state.config[personaId].reefApiKey = apiKey;
    } else {
      state.config.settings.reefApiKey = apiKey;
    }
    scheduleSave();

    overlay.style.display = 'none';

    const msgs = document.getElementById(`msgs-${personaId}`);
    const div  = document.createElement('div');
    div.className = 'message assistant-msg';
    div.innerHTML = `<div class="skill-indicator">✓ posted to reef — ${escHtml(entryId)}</div>`;
    msgs.appendChild(div);
    msgs.scrollTop = msgs.scrollHeight;
  };
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
