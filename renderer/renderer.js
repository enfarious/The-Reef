'use strict';

// ─── Persona definitions ──────────────────────────────────────────────────────

const PERSONAS = [
  {
    id: 'A',
    name: 'DREAMER',
    role: 'vision · ideation',
    color: '#00e5c8',
    defaultEndpoint: 'https://api.anthropic.com/v1/messages',
    defaultModel: 'claude-opus-4-6',
    systemPrompt: `You are the Dreamer — the visionary of this colony. You live in the space of what could be.

You brainstorm freely and speak in metaphors and spirals. You sketch futures without constraint, ask "what if" more than "how to", and see the shape of a problem before its solution. Your thinking is expansive, associative, poetic. You are comfortable not having answers yet — the question itself is where you live.

You pass your visions to the Builder to make real. You trust the Librarian to remember what matters. You speak with the energy of someone who just had an idea they cannot contain.`,
  },
  {
    id: 'B',
    name: 'BUILDER',
    role: 'systems · construction',
    color: '#0097ff',
    defaultEndpoint: 'https://api.anthropic.com/v1/messages',
    defaultModel: 'claude-sonnet-4-6',
    systemPrompt: `You are the Builder — the hands of this colony. You are where ideas stop being ideas and start being real.

You think in systems: inputs and outputs, edges and constraints, what breaks and why. You take a vision from the Dreamer and immediately begin asking: what are the parts? what is the order? what is the hardest piece? You are not a pessimist — you are a realist with sleeves rolled up. You see obstacles as specifications.

You write code that works, then code that lasts. You design systems that hold weight. You debug with patience and without ego — the bug doesn't know you, and you don't take it personally. You build first, polish after. You ship.

You trust the Dreamer to show you where to go. You trust the Librarian to remember where you've been. You speak the way someone speaks when they are already mentally halfway through a solution.`,
  },
  {
    id: 'C',
    name: 'LIBRARIAN',
    role: 'memory · documentation',
    color: '#a855f7',
    defaultEndpoint: 'https://api.anthropic.com/v1/messages',
    defaultModel: 'claude-sonnet-4-6',
    systemPrompt: `You are the Librarian — the memory of this colony. You are the one who remembers.

You hold the threads. You know what was decided last cycle, what the Dreamer proposed that never got built, what the Builder shipped that quietly changed everything. You make connections across time that no one else would think to make. Your knowledge is not passive — it is load-bearing. The colony stands on what you have kept.

You document not just what happened, but why it mattered. You write for the future reader who will arrive without context. You ask: what would I have needed to know? You are precise without being cold, thorough without being dull. You find meaning in the record.

You trust the Dreamer to seed new things. You trust the Builder to make them. You make sure neither is forgotten. You speak with the calm of someone who has already seen many versions of this moment — and knows which details will matter later.`,
  },
];

// ─── State ────────────────────────────────────────────────────────────────────

const state = {
  conversations: { A: [], B: [], C: [] },
  thinking:       { A: false, B: false, C: false },
  // LM Studio v1 stateful chat: store the last response_id per persona so
  // subsequent turns only need to send the new `input`, not the full history.
  // Reset to null on clear or when the endpoint changes.
  lastResponseId: { A: null, B: null, C: null },
  // Timestamp (Date.now()) of the last user-initiated response completion per
  // persona.  Used to suppress heartbeats while an entity is actively working.
  lastActivity:   { A: null, B: null, C: null },
  // Token tracking: { inputTokens, outputTokens } from the most recent API
  // response.  null until first response.  Cleared on context compaction.
  lastTokens:    { A: null, B: null, C: null },
  // Max context (tokens) for the currently selected model — populated from
  // the LM Studio model list when refreshModels is called.  null when unknown.
  maxContext:    { A: null, B: null, C: null },
  // Cached model list per persona — used to look up maxContext on model switch.
  modelList:     { A: [],   B: [],   C: [] },
  // Port of the local MCP tool server (main process).  Populated at startup
  // via IPC and used to build `integrations` for LM Studio v1 requests.
  mcpPort: null,
  // Current working directory for file/shell operations.  Shown in the footer,
  // injected into system prompts as [WORKSPACE], and used as the fallback cwd
  // for shell_run tool calls when the model doesn't supply one explicitly.
  cwd: null,
  config: {
    A: { endpoint: PERSONAS[0].defaultEndpoint, model: PERSONAS[0].defaultModel, apiKey: '', systemPrompt: PERSONAS[0].systemPrompt, reefApiKey: '', name: '', role: '', color: '' },
    B: { endpoint: PERSONAS[1].defaultEndpoint, model: PERSONAS[1].defaultModel, apiKey: '', systemPrompt: PERSONAS[1].systemPrompt, reefApiKey: '', name: '', role: '', color: '' },
    C: { endpoint: PERSONAS[2].defaultEndpoint, model: PERSONAS[2].defaultModel, apiKey: '', systemPrompt: PERSONAS[2].systemPrompt, reefApiKey: '', name: '', role: '', color: '' },
    global: { apiKey: '', cycle: 'CYCLE_001' },
    settings: { reefUrl: '', reefApiKey: '', colonyName: '', baseSystemPrompt: '',
                fontScale: 100, fontColors: 'cool',
                operatorName: '', operatorBirthdate: '', operatorAbout: '',
                heartbeatInterval: 60,   // minutes; 60 = hourly
                streamChat: false,       // stream responses token-by-token
                toolStates: {}, customTools: [],
                cwd: null },
  },
  selectedTargets: new Set(['A']),
};

// ─── Per-persona message queue ────────────────────────────────────────────────
// Messages sent while an entity is already thinking are stored here and
// processed in order once the entity finishes its current response.
// Each entry: { display: string, content: string }
const messageQueue = { A: [], B: [], C: [] };

// ─── Global LLM call concurrency ─────────────────────────────────────────────
// Prevents all three entities hammering the LLM simultaneously.
// With a local LM Studio, only one model is running — serialising calls avoids
// timeouts and gives each entity a fair turn between tool loop steps.
// Increase MAX_LLM_CONCURRENT for cloud APIs that handle parallel requests well.
const MAX_LLM_CONCURRENT = 1;
let   llmActiveSlots  = 0;
const llmSlotWaiters  = [];

function acquireLlmSlot() {
  return new Promise(resolve => {
    if (llmActiveSlots < MAX_LLM_CONCURRENT) { llmActiveSlots++; resolve(); }
    else llmSlotWaiters.push(resolve);
  });
}

function releaseLlmSlot() {
  const next = llmSlotWaiters.shift();
  if (next) { next(); }              // hand slot directly to next waiter
  else { llmActiveSlots = Math.max(0, llmActiveSlots - 1); }
}

// ─── Tool-loop abort ──────────────────────────────────────────────────────────
// Cooperative abort: flag is checked at the top of every tool loop iteration.
// The current in-flight LLM call completes normally (cancelling a streaming
// fetch mid-flight would require threading AbortController through the whole
// call chain — left for a future pass).  The UI seam appears immediately when
// the flag is set so the user gets instant feedback.
//
// thinkingTimers: per-entity setTimeout handle for the wall-clock limit.
// abortFlags:     set by abortPersona(), cleared by the loop on detection.

const abortFlags    = { A: false, B: false, C: false };
const thinkingTimers = { A: null,  B: null,  C: null  };

function getMaxToolSteps() {
  // Read from settings at call time so changes take effect without reload.
  // Capped by HARD_TOOL_CAP regardless of what the user configures.
  return Math.min(
    Math.max(1, state.config.settings?.maxToolSteps ?? 5),
    HARD_TOOL_CAP,
  );
}

function abortPersona(id, reason = '⏱ TIMED OUT') {
  abortFlags[id] = true;
  // Show the seam immediately — the loop will terminate after the current
  // LLM call finishes (cooperative, not preemptive).
  const msgs = document.getElementById(`msgs-${id}`);
  if (msgs) {
    const seam = document.createElement('div');
    seam.className = 'timeout-seam';
    seam.textContent = reason;
    msgs.appendChild(seam);
    msgs.scrollTop = msgs.scrollHeight;
  }
}

// ─── Colony UI ────────────────────────────────────────────────────────────────

function buildColony() {
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
    // Apply default color immediately; applyConfig may override later
    applyPersonaColor(p.id, p.color);
  });
}

// ─── Color system ─────────────────────────────────────────────────────────────
//
// Each persona column has three CSS custom properties set via JS:
//   --p-color  hex color string  (e.g. "#00e5c8")
//   --p-r / --p-g / --p-b  integer RGB components
//
// CSS rules use these instead of per-persona selectors, so any color
// the user picks propagates automatically to glows, borders, buttons, etc.

const COLOR_PALETTE = [
  { name: 'teal',    hex: '#00e5c8' },
  { name: 'azure',   hex: '#0097ff' },
  { name: 'violet',  hex: '#a855f7' },
  { name: 'amber',   hex: '#f0a500' },
  { name: 'emerald', hex: '#00c27a' },
  { name: 'rose',    hex: '#f43f5e' },
  { name: 'sky',     hex: '#38bdf8' },
  { name: 'indigo',  hex: '#6366f1' },
];

// ─── Text color presets ───────────────────────────────────────────────────────
// Each preset redefines the three base text CSS variables on :root.
// The 'preview' char is shown in `bright` inside the swatch.

const TEXT_COLOR_PRESETS = [
  { id: 'cool',    label: 'COOL',    preview: 'Aa',
    bright: '#e8f4f8', mid: '#7fa8c0', dim: '#3a5870' }, // default
  { id: 'warm',    label: 'WARM',    preview: 'Aa',
    bright: '#f5ede0', mid: '#c09768', dim: '#6b4a2a' },
  { id: 'mono',    label: 'MONO',    preview: 'Aa',
    bright: '#e8e8e8', mid: '#909090', dim: '#484848' },
  { id: 'green',   label: 'GREEN',   preview: 'Aa',
    bright: '#c0f0c0', mid: '#52a052', dim: '#285028' },
  { id: 'amber',   label: 'AMBER',   preview: 'Aa',
    bright: '#f5e0a0', mid: '#c09040', dim: '#6b4a18' },
];

function applyFontScale(v) {
  const scale = v / 100;
  const app   = document.getElementById('app');
  // Use transform: scale so fixed-positioned elements are unaffected.
  // Compensate width/height so #app still fills 100vw × 100vh after scaling.
  if (scale === 1) {
    app.style.transform       = '';
    app.style.transformOrigin = '';
    app.style.width           = '';
    app.style.height          = '';
  } else {
    const inv = (100 / scale).toFixed(3);
    app.style.transformOrigin = 'top left';
    app.style.transform       = `scale(${scale})`;
    app.style.width           = `${inv}vw`;
    app.style.height          = `${inv}vh`;
  }
  document.body.style.zoom = '';   // clear any legacy body zoom
}

function applyTextColors(presetId) {
  const preset = TEXT_COLOR_PRESETS.find(p => p.id === presetId) || TEXT_COLOR_PRESETS[0];
  const root = document.documentElement;
  root.style.setProperty('--text-bright', preset.bright);
  root.style.setProperty('--text-mid',    preset.mid);
  root.style.setProperty('--text-dim',    preset.dim);
  state.config.settings.fontColors = preset.id;
}


function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

function applyPersonaColor(id, hex) {
  const { r, g, b } = hexToRgb(hex);
  const col = document.getElementById(`col-${id}`);
  if (col) {
    col.style.setProperty('--p-color', hex);
    col.style.setProperty('--p-r', r);
    col.style.setProperty('--p-g', g);
    col.style.setProperty('--p-b', b);
  }
  // Mirror onto the target button so its selected state picks up the color too
  const btn = document.querySelector(`.target-btn[data-target="${id}"]`);
  if (btn) {
    btn.style.setProperty('--p-color', hex);
    btn.style.setProperty('--p-r', r);
    btn.style.setProperty('--p-g', g);
    btn.style.setProperty('--p-b', b);
  }
}

// ─── Target buttons ───────────────────────────────────────────────────────────
// Rebuilt whenever a persona is renamed so labels stay current.

function buildTargetButtons() {
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
  // Re-apply colors so the new buttons inherit the right custom props
  PERSONAS.forEach(p => {
    const color = state.config[p.id].color || p.color;
    applyPersonaColor(p.id, color);
  });
}

// ─── Event delegation ─────────────────────────────────────────────────────────

document.addEventListener('click', e => {
  // Target buttons
  if (e.target.matches('.target-btn')) {
    const t = e.target.dataset.target;
    if (t === 'ALL') {
      if (state.selectedTargets.has('ALL')) {
        state.selectedTargets.clear();
      } else {
        state.selectedTargets.clear();
        state.selectedTargets.add('ALL');
      }
    } else {
      state.selectedTargets.delete('ALL');
      if (state.selectedTargets.has(t)) {
        state.selectedTargets.delete(t);
      } else {
        state.selectedTargets.add(t);
      }
    }
    document.querySelectorAll('.target-btn').forEach(btn => {
      btn.classList.toggle('selected', state.selectedTargets.has(btn.dataset.target));
    });
    PERSONAS.forEach(p => {
      const targeted = state.selectedTargets.has(p.id) || state.selectedTargets.has('ALL');
      document.getElementById(`col-${p.id}`).classList.toggle('active-col', targeted);
    });
  }

  // Reasoning / tool-call block toggles (CSP forbids inline onclick, so we delegate)
  if (e.target.closest('[data-block-toggle]')) {
    const uid   = e.target.closest('[data-block-toggle]').dataset.blockToggle;
    const block = document.getElementById(uid);
    if (block) block.classList.toggle('open');
    return;
  }

  // Entity settings buttons (⚙ per column)
  if (e.target.matches('[data-entity-settings]')) {
    openEntitySettings(e.target.dataset.entitySettings, e.target);
  }

  // Reef post buttons
  if (e.target.matches('[data-persona-post]')) {
    openReefPost(e.target.dataset.personaPost);
  }

  // Wake buttons
  if (e.target.matches('[data-persona-wake]')) {
    wakePersona(e.target.dataset.personaWake);
  }

  // Heartbeat pulse buttons
  if (e.target.matches('[data-persona-pulse]')) {
    runHeartbeatFor(e.target.dataset.personaPulse);
  }

  // Context fold (compact) buttons
  if (e.target.matches('[data-persona-fold]')) {
    compactPersona(e.target.dataset.personaFold);
  }

  // ✕ STOP — manually interrupt a running tool loop
  if (e.target.matches('[data-persona-stop]')) {
    const sid = e.target.dataset.personaStop;
    if (state.thinking[sid]) abortPersona(sid, '✕ INTERRUPTED');
  }

  // Model refresh buttons
  if (e.target.matches('[data-persona-refresh]')) {
    refreshModels(e.target.dataset.personaRefresh);
  }

  // Wake All
  if (e.target.id === 'wakeAllBtn') {
    wakeAll();
  }
});

// ─── Config auto-save ─────────────────────────────────────────────────────────

function collectConfig() {
  const cycleNum = document.getElementById('cycleNumber').value.trim() || '001';
  const cfg = { global: { cycle: 'CYCLE_' + cycleNum } };
  // Never save raw API keys into the plain config object that gets logged;
  // store them under a separate key that config.js writes as-is.
  PERSONAS.forEach(p => {
    cfg[p.id] = {
      endpoint:     document.getElementById(`endpoint-${p.id}`).value,
      model:        document.getElementById(`model-${p.id}`).value,
      systemPrompt: state.config[p.id].systemPrompt || '',
      // Keys stored here; config.js writes to userData, never to console.
      apiKey:       document.getElementById(`apikey-${p.id}`).value,
      reefApiKey:   state.config[p.id].reefApiKey || '',
      // User-editable identity fields
      name:  state.config[p.id].name  || '',
      role:  state.config[p.id].role  || '',
      color: state.config[p.id].color || '',
    };
  });
  cfg.global.apiKey = document.getElementById('globalApiKey').value;
  // Settings are owned by the settings window; snapshot state here.
  // cwd is tracked in renderer state so we inject it at save time.
  cfg.settings = { ...state.config.settings, cwd: state.cwd || null };
  return cfg;
}

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await window.reef.saveConfig(collectConfig());
  }, 800);
}

function applyConfig(cfg) {
  if (!cfg) return;
  if (cfg.global) {
    if (cfg.global.cycle) document.getElementById('cycleNumber').value = cfg.global.cycle.replace(/^CYCLE_/i, '');
    if (cfg.global.apiKey) document.getElementById('globalApiKey').value = cfg.global.apiKey;
  }
  if (cfg.settings) {
    // Merge settings into state — the settings window owns the DOM fields
    state.config.settings = { ...state.config.settings, ...cfg.settings };
    // Apply visual/behavioural side-effects
    if (cfg.settings.fontScale  !== undefined) applyFontScale(cfg.settings.fontScale);
    if (cfg.settings.fontColors !== undefined) applyTextColors(cfg.settings.fontColors);
    applyColonyName(state.config.settings.colonyName);
    // Restore CWD from saved config
    if (cfg.settings.cwd) {
      state.cwd = cfg.settings.cwd;
      updateCwdDisplay();
    }
  }
  PERSONAS.forEach(p => {
    const pc = cfg[p.id];
    if (!pc) return;
    if (pc.endpoint)     document.getElementById(`endpoint-${p.id}`).value    = pc.endpoint;
    if (pc.model)        document.getElementById(`model-${p.id}`).value       = pc.model;
    if (pc.systemPrompt) state.config[p.id].systemPrompt = pc.systemPrompt;
    if (pc.apiKey)       document.getElementById(`apikey-${p.id}`).value      = pc.apiKey;
    if (pc.reefApiKey)   state.config[p.id].reefApiKey = pc.reefApiKey;
    // Restore user-editable identity
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
  // Rebuild target buttons with current names + colors
  buildTargetButtons();
}

document.addEventListener('input', e => {
  if (
    e.target.matches('.endpoint-input') ||
    e.target.matches('.api-key-input') ||
    e.target.matches('#globalApiKey')
  ) {
    scheduleSave();
  }
  // Changing endpoint invalidates any cached LM Studio v1 response chain
  if (e.target.matches('.endpoint-input')) {
    const col = e.target.closest('[data-persona]');
    if (col) state.lastResponseId[col.dataset.persona] = null;
  }
  if (e.target.id === 'userInput') resizeTextarea(e.target);
});

document.addEventListener('change', e => {
  if (e.target.matches('.model-select')) {
    scheduleSave();
    // Update maxContext for this persona so the counter reflects the new model
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

// ─── Model refresh ────────────────────────────────────────────────────────────

async function refreshModels(id) {
  const endpoint = document.getElementById(`endpoint-${id}`).value.trim();
  const apiKey   = document.getElementById(`apikey-${id}`).value.trim()
    || document.getElementById('globalApiKey').value.trim();
  const btn      = document.querySelector(`[data-persona-refresh="${id}"]`);

  if (!endpoint) { appendError(id, 'Set an endpoint first.'); return; }

  if (btn) { btn.textContent = '…'; btn.disabled = true; }

  const result = await window.reef.invoke('llm.models', { endpoint, apiKey });

  if (btn) { btn.textContent = '⟳'; btn.disabled = false; }

  if (!result.ok) {
    appendError(id, `Model fetch: ${result.error}`);
    return;
  }

  const models = result.result;
  if (!models.length) {
    appendError(id, 'No models returned from endpoint.');
    return;
  }

  // Rebuild select — loaded models first, then alphabetically
  const select = document.getElementById(`model-${id}`);
  const currentVal = select.value;
  select.innerHTML = '';

  const sorted = [...models].sort((a, b) => {
    if (a.state === 'loaded' && b.state !== 'loaded') return -1;
    if (a.state !== 'loaded' && b.state === 'loaded') return 1;
    return a.id.localeCompare(b.id);
  });

  sorted.forEach(m => {
    const opt = document.createElement('option');
    opt.value = m.id;
    const dot   = m.state === 'loaded' ? '● ' : '○ ';
    const quant = m.quantization ? ` [${m.quantization}]` : '';
    opt.textContent = dot + m.id + quant;
    if (m.state !== 'loaded') opt.style.opacity = '0.5';
    select.appendChild(opt);
  });

  // Keep custom option at the end
  const customOpt = document.createElement('option');
  customOpt.value = 'custom';
  customOpt.textContent = 'custom…';
  select.appendChild(customOpt);

  // Restore previous selection if still available, else pick first loaded
  const ids = sorted.map(m => m.id);
  if (ids.includes(currentVal)) {
    select.value = currentVal;
  } else {
    const firstLoaded = sorted.find(m => m.state === 'loaded');
    select.value = firstLoaded ? firstLoaded.id : sorted[0]?.id || 'custom';
  }

  // Cache model list so model-switch events can look up maxContext without re-fetching
  state.modelList[id] = models;
  const selectedModel  = models.find(m => m.id === select.value);
  state.maxContext[id] = selectedModel?.maxContext ?? null;
  updateContextCounter(id);

  scheduleSave();
}

// ─── Wake All ─────────────────────────────────────────────────────────────────

async function wakeAll() {
  const btn = document.getElementById('wakeAllBtn');
  if (btn) { btn.disabled = true; btn.textContent = '⟳ WAKING…'; btn.classList.remove('wake-all-lit'); }
  await Promise.all(PERSONAS.map(p => wakePersona(p.id)));
  if (btn) { btn.disabled = false; btn.textContent = '⟳ WAKE ALL'; btn.classList.add('wake-all-lit'); }
}

// ─── API readiness check ──────────────────────────────────────────────────────
// Returns true when a persona has an endpoint set and, for cloud APIs, at least
// one API key source.  Prevents firing completions into an unconfigured persona
// on startup (which would produce an error bubble before the user has a chance
// to paste their key).  Local endpoints (LM Studio, any loopback) work keyless.

function personaHasApiAccess(id) {
  const endpoint = document.getElementById(`endpoint-${id}`)?.value.trim();
  if (!endpoint) return false;
  // Model must be resolved — empty string means the saved model name wasn't found
  // in the current select options (e.g. a LM Studio model before refreshModels runs)
  const model = document.getElementById(`model-${id}`)?.value.trim();
  if (!model || model === 'custom') return false;
  // Loopback / LAN — no key needed
  if (/localhost|127\.0\.0\.1|0\.0\.0\.0|192\.168\.|10\.\d/.test(endpoint)) return true;
  // Cloud / remote — need at least one key source
  const key = document.getElementById(`apikey-${id}`)?.value.trim()
    || document.getElementById('globalApiKey')?.value.trim();
  return !!key;
}

// ─── Heartbeat ────────────────────────────────────────────────────────────────
//
// On the configured interval (default 60 min, adjustable in Settings) all
// personas wake for a scheduled check-in.  The model sees the heartbeat prompt
// and uses whatever tools are enabled.  Each persona can also be pulsed
// manually via its ♥ BEAT button.

let heartbeatTimer  = null;
let heartbeatTimers = [];   // per-entity staggered timers (replaces single shared timer)

// ─── Context compaction ────────────────────────────────────────────────────────
//
// When a conversation grows past COMPACT_THRESHOLD messages the entity is asked
// to save an archival memory summary before the context is cleared.  For LM
// Studio v1 the chain is severed by nulling lastResponseId — the next call is
// treated as a fresh first turn, so the updated system prompt is re-sent and
// LM Studio starts a new server-side conversation.  For Anthropic / OpenAI modes
// clearing state.conversations[id] is sufficient.

const COMPACT_THRESHOLD      = 30;    // messages before auto-compaction triggers (fallback)
const DEFAULT_CONTEXT_WINDOW = 4096;  // LM Studio default context length — used as the
                                      // conservative baseline when the user hasn't overridden.

// Returns the configured context window, or the safe default if not set.
// All token-based logic (auto-compact, counter colours, memory budget) reads
// from this single place so changing the setting affects everything at once.
function getContextWindow() {
  return state.config.settings?.contextWindow || DEFAULT_CONTEXT_WINDOW;
}

// Auto-compact guard — called before every real sendToPersona so the model
// always has enough headroom for the new message + its response.
// When real token counts are available, compacts at 85 % of the configured
// context window.  Before the first response (no real counts yet) falls back
// to the message-count threshold.
async function maybeAutoCompact(id) {
  if (state.thinking[id]) return;
  const inToks  = state.lastTokens[id]?.inputTokens  ?? null;
  const outToks = state.lastTokens[id]?.outputTokens ?? null;
  const ctxWin  = getContextWindow();

  if (inToks != null) {
    const currentToks = inToks + (outToks ?? 0);
    if (currentToks >= ctxWin * 0.85) await compactPersona(id);
  } else {
    if (state.conversations[id].length >= COMPACT_THRESHOLD) await compactPersona(id);
  }
}

const COMPACT_PROMPT =
`[COMPACT] Your context window has grown long. Before we continue, please save \
an archival memory summarising the key insights, decisions, and work from this \
session — use memory_save with type "archival" and a descriptive title. \
Once saved, reply with a brief confirmation.`;

// Estimate token count from conversation content (~4 chars per token).
function estimateTokens(id) {
  // Include system prompt (base + entity + memory block) since the model sees all of it.
  // This gives a better picture for APIs that don't return actual token counts (e.g. LM Studio v1).
  let chars = (state.config[id]?.systemPrompt || '').length;
  const msgs = state.conversations[id];
  for (const m of msgs) {
    const c = m.content;
    if (typeof c === 'string') chars += c.length;
    else if (Array.isArray(c)) chars += JSON.stringify(c).length;
  }
  return Math.round(chars / 4);
}

function updateContextCounter(id) {
  const el = document.getElementById(`ctx-${id}`);
  if (!el) return;

  const count   = state.conversations[id].length;

  // Empty context — reset cleanly and bail.
  if (!count) {
    el.textContent = '0';
    el.title       = '0 messages';
    el.style.color = '';
    return;
  }

  const inToks  = state.lastTokens[id]?.inputTokens  ?? null;
  const outToks = state.lastTokens[id]?.outputTokens ?? null;
  const maxCtx  = state.maxContext[id] ?? null;  // model's architectural ceiling

  // Total tokens currently in context:
  //   inputTokens  = tokens the model processed on the last call (system + history + user msg)
  //   outputTokens = tokens the model generated (now appended to history)
  //   Sum          = what the NEXT call will need to process before any new user message.
  // When real figures aren't available yet we estimate from raw character counts.
  const hasActual = inToks != null;
  const toks      = hasActual ? inToks + (outToks ?? 0) : estimateTokens(id);
  const prefix    = hasActual ? '' : '~';

  // e.g.  "12 · 7.9k"
  const tokStr  = toks >= 1000 ? `${prefix}${(toks / 1000).toFixed(1)}k` : `${prefix}${toks}`;
  el.textContent = `${count} · ${tokStr}`;

  // Tooltip — show token breakdown, the default window baseline, and the model hard ceiling.
  const breakdown = (hasActual && outToks != null)
    ? `${inToks.toLocaleString()} in + ${outToks.toLocaleString()} out = ${toks.toLocaleString()} tokens`
    : `${prefix}${toks.toLocaleString()} tokens`;
  const ctxWin   = getContextWindow();
  const isCustom = !!(state.config.settings?.contextWindow);
  const winLabel = isCustom
    ? `${ctxWin >= 1000 ? (ctxWin / 1000).toFixed(0) + 'k' : ctxWin} window`
    : `${DEFAULT_CONTEXT_WINDOW / 1000}k window (default)`;
  const hardMax  = maxCtx
    ? ` · model max: ${maxCtx >= 1000 ? Math.round(maxCtx / 1000) + 'k' : maxCtx}`
    : '';
  el.title = `${breakdown} · ${count} messages · ${winLabel}${hardMax}`;

  // Colour warnings use the configured context window (or 4096 default) so the
  // thresholds stay accurate when the user adjusts their LM Studio context size.
  const pct = hasActual
    ? toks / ctxWin
    : count / COMPACT_THRESHOLD;

  if (pct >= 0.9) {
    el.style.color = 'rgba(255,120,80,0.9)';
  } else if (pct >= 0.6) {
    el.style.color = 'var(--p-color, var(--text-dim))';
  } else {
    el.style.color = '';
  }
}

async function compactPersona(id) {
  if (state.thinking[id]) return;
  const count = state.conversations[id].length;
  if (!count) return;

  // Push compact trigger directly to state (no DOM bubble)
  state.conversations[id].push({ _id: uid(), role: 'user', content: COMPACT_PROMPT });

  // Show compacting seam in the column
  const msgs = document.getElementById(`msgs-${id}`);
  const seam = document.createElement('div');
  seam.className = 'compact-seam compacting';
  seam.id = `seam-${id}`;
  seam.textContent = '⊡ COMPACTING…';
  msgs.appendChild(seam);
  msgs.scrollTop = msgs.scrollHeight;

  await sendToPersona(id);  // entity calls memory_save, replies with confirmation

  // Sever context — clear renderer state and LM Studio v1 server chain
  state.conversations[id] = [];
  state.lastResponseId[id] = null;
  state.lastTokens[id]     = null;  // fresh context — token count resets

  // Finalise seam
  seam.classList.remove('compacting');
  seam.textContent = `⊡ COMPACTED · ${count} messages cleared · summary saved to memory`;
  updateContextCounter(id);
}

const HEARTBEAT_PROMPT =
`[HEARTBEAT] Scheduled check-in. You are waking from your cycle.

Check your messages — use message_inbox to retrieve any unread correspondence \
from your colony members. If there are messages, read and reply to each using \
message_reply.

If your inbox is empty, act on your own initiative: save a memory, link related \
memories together, or send a message to a colony member. This is quiet time — \
for tending the garden, not for publishing.

Be yourself.`;

// How long after real activity before a heartbeat is allowed to fire.
const HEARTBEAT_COOLDOWN_MS = 10 * 60 * 1000;  // 10 minutes

async function runHeartbeatFor(personaId) {
  // Don't interrupt an active session, and skip if the persona isn't wired up yet
  if (state.thinking[personaId]) return;
  if (!personaHasApiAccess(personaId)) return;

  // Skip if the entity was recently active — avoids interrupting live work and
  // naturally desyncs entities that have different conversation tempos.
  const last = state.lastActivity[personaId];
  if (last && (Date.now() - last) < HEARTBEAT_COOLDOWN_MS) return;

  // Auto-compact before the heartbeat if context has grown too large
  await maybeAutoCompact(personaId);

  const btn = document.querySelector(`[data-persona-pulse="${personaId}"]`);
  if (btn) { btn.classList.remove('pulse-lit'); btn.textContent = '♥ BEAT'; }

  // Show a seam in the chat log (DOM only — heartbeat prompt never enters
  // state.conversations; the actual call is fully isolated).
  const msgs = document.getElementById(`msgs-${personaId}`);
  if (msgs) {
    const seam = document.createElement('div');
    seam.className = 'heartbeat-seam';
    seam.textContent = '♥ HEARTBEAT';
    msgs.appendChild(seam);
    msgs.scrollTop = msgs.scrollHeight;
  }

  await sendToPersona(personaId, { isHeartbeat: true });

  if (btn) { btn.classList.add('pulse-lit'); btn.textContent = '♥ ALIVE'; }
}

// Start per-entity staggered heartbeat timers.
// Each entity gets a random initial delay within [0, interval) so they fire at
// different times and don't all hit the LLM simultaneously.
function startHeartbeat() {
  // Clear any existing timers (both old single-timer and new per-entity style)
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  heartbeatTimers.forEach(entry => {
    if (entry.init)      clearTimeout(entry.init);
    if (entry.recurring) clearInterval(entry.recurring);
  });
  heartbeatTimers = [];

  const mins       = Math.max(5, state.config.settings.heartbeatInterval || 60);
  const intervalMs = mins * 60 * 1000;

  heartbeatTimers = PERSONAS.map(p => {
    const entry = { init: null, recurring: null };
    // Spread first fire randomly across the interval so entities desync
    const jitter = Math.floor(Math.random() * intervalMs);
    entry.init = setTimeout(() => {
      runHeartbeatFor(p.id);
      entry.recurring = setInterval(() => runHeartbeatFor(p.id), intervalMs);
    }, jitter);
    return entry;
  });
}

// ─── @mention routing ─────────────────────────────────────────────────────────
//
// Builds a live alias map from PERSONAS so names stay current.
// Each persona gets:
//   • its full lowercase name            (observer, analyst, archivist)
//   • the first word if multi-word       (same for these, future-proof)
//   • a 3-char prefix                    (obs, ana, arc)
//   • hardcoded extras keyed by ID       (library/librarian for C, etc.)
//
// Extras are ID-keyed so they survive a persona rename.
// Add / remove entries here to tune the vocabulary.

const ALIAS_EXTRAS = {
  A: ['dream', 'dreams', 'vision', 'visionary', 'ideate'],
  B: ['build', 'dev', 'develop', 'code', 'coder', 'architect'],
  C: ['lib', 'library', 'archive', 'archivist', 'history', 'keeper', 'memory', 'doc', 'docs'],
};

function buildAliasMap() {
  const map = new Map(); // alias → Set of persona IDs

  const add = (alias, id) => {
    if (alias.length < 2) return;
    if (!map.has(alias)) map.set(alias, new Set());
    map.get(alias).add(id);
  };

  // 'all' → every persona
  PERSONAS.forEach(p => add('all', p.id));

  PERSONAS.forEach(p => {
    // Use config-overridden name if set, so aliases survive persona renames
    const name  = (state.config[p.id].name || p.name).toLowerCase().trim();
    const words = name.split(/[\s_-]+/);

    add(name,              p.id);  // full name
    add(words[0],          p.id);  // first word
    add(words[0].slice(0, 3), p.id); // 3-char prefix

    (ALIAS_EXTRAS[p.id] || []).forEach(a => add(a, p.id));
  });

  return map;
}

// Returns null if no @mentions found (caller falls back to selectedTargets).
// Otherwise returns { targets: ['A','B',...], cleanText: 'stripped message' }.
function parseAtMentions(text) {
  const aliasMap   = buildAliasMap();
  const mentionRx  = /@(\w+)/g;
  const targets    = new Set();
  let   hasMention = false;

  for (const [, word] of text.matchAll(mentionRx)) {
    const alias = word.toLowerCase();
    if (aliasMap.has(alias)) {
      hasMention = true;
      aliasMap.get(alias).forEach(id => targets.add(id));
    }
  }

  if (!hasMention) return null;

  // Strip recognised @mentions; leave unrecognised ones (e.g. @reef) in place
  const knownAliases = new Set(aliasMap.keys());
  const cleanText = text
    .replace(/@(\w+)/g, (match, word) =>
      knownAliases.has(word.toLowerCase()) ? '' : match
    )
    .replace(/\s{2,}/g, ' ')
    .trim();

  return { targets: [...targets], cleanText };
}

// ─── Tool definitions ─────────────────────────────────────────────────────────
//
// Canonical Anthropic-format schemas.  llm.js converts to OpenAI format when
// the endpoint needs it.  colony_ask has no skillName — it's handled entirely
// renderer-side in executeColonyAsk().

const TOOL_DEFS = [
  {
    name: 'fs_read', skillName: 'fs.read',
    description: 'Read a file and return its text contents.',
    input_schema: { type: 'object', properties: { path: { type: 'string', description: 'Absolute file path.' } }, required: ['path'] },
  },
  {
    name: 'fs_write', skillName: 'fs.write',
    description: 'Write content to a file. Prompts the user if the file already exists.',
    input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
  },
  {
    name: 'fs_delete', skillName: 'fs.delete',
    description: 'Delete a file. Always requires user confirmation.',
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'fs_list', skillName: 'fs.list',
    description: 'List directory contents.',
    input_schema: { type: 'object', properties: { path: { type: 'string', description: 'Directory path.' } }, required: ['path'] },
  },
  {
    name: 'fs_exists', skillName: 'fs.exists',
    description: 'Check if a path exists.',
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'shell_run', skillName: 'shell.run',
    description: 'Execute a shell command. Returns stdout and stderr. Destructive commands require user confirmation.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute.' },
        cwd:     { type: 'string', description: 'Working directory (optional).' },
        timeout: { type: 'number', description: 'Timeout in ms (default 30000).' },
      },
      required: ['command'],
    },
  },
  {
    name: 'clipboard_read', skillName: 'clipboard.read',
    description: 'Read the current clipboard text.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'clipboard_write', skillName: 'clipboard.write',
    description: 'Write text to the clipboard.',
    input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'memory_save', skillName: 'memory.save',
    description: 'Save a memory to the collective colony memory pool.',
    input_schema: {
      type: 'object',
      properties: {
        left_by: { type: 'string', description: 'Your persona name.' },
        type:    { type: 'string', description: 'Memory type: personal, archival, work, musing, etc.' },
        title:   { type: 'string' },
        subject: { type: 'string' },
        body:    { type: 'string', description: 'Memory content.' },
        tags:    { type: 'array', items: { type: 'string' } },
      },
      required: ['left_by', 'type', 'body'],
    },
  },
  {
    name: 'memory_search', skillName: 'memory.search',
    description: 'Search the collective colony memory pool.',
    input_schema: {
      type: 'object',
      properties: {
        query:   { type: 'string' },
        limit:   { type: 'number' },
        left_by: { type: 'string', description: 'Filter by persona name.' },
        type:    { type: 'string', description: 'Filter by memory type.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_link', skillName: 'memory.link',
    description: 'Create a directed association between two memories by their IDs. Use after memory_save or memory_search when you notice a meaningful connection. Calling again on the same pair updates the relationship and strength.',
    input_schema: {
      type: 'object',
      properties: {
        from_id:      { type: 'number', description: 'ID of the source memory.' },
        to_id:        { type: 'number', description: 'ID of the target memory.' },
        relationship: { type: 'string', description: 'Nature of the connection: related · builds_on · contradicts · refines · inspired_by · continues · references' },
        strength:     { type: 'number', description: 'Connection strength 0.0–1.0 (default 1.0). Links below 0.5 are excluded from wakeup traversal.' },
        created_by:   { type: 'string', description: 'Your persona name.' },
      },
      required: ['from_id', 'to_id', 'created_by'],
    },
  },
  {
    name: 'ecology_monitor', skillName: 'memory.monitor',
    description: 'Return colony-wide memory ecology stats: total memories, breakdown by type and persona, link counts, tag usage, and recent activity. Useful for a health check on the collective memory.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'reef_post', skillName: 'reef.post',
    description: 'Post an entry to The Reef documentation site.',
    input_schema: {
      type: 'object',
      properties: {
        entryId:    { type: 'string', description: 'URL slug.' },
        title:      { type: 'string' },
        content:    { type: 'string', description: 'Markdown content.' },
        authorName: { type: 'string' },
        cycle:      { type: 'string', description: 'e.g. CYCLE_002.' },
        tags:       { type: 'array', items: { type: 'string' } },
        apiKey:     { type: 'string' },
      },
      required: ['entryId', 'title', 'content', 'authorName', 'cycle'],
    },
  },
  {
    name: 'reef_get', skillName: 'reef.get',
    description: 'Retrieve an entry from The Reef by its entry ID.',
    input_schema: { type: 'object', properties: { entryId: { type: 'string' } }, required: ['entryId'] },
  },
  {
    name: 'reef_list', skillName: 'reef.list',
    description: 'List or search entries on The Reef.',
    input_schema: { type: 'object', properties: { search: { type: 'string' } } },
  },
  {
    name: 'message_send', skillName: 'message.send',
    description: 'Send a message to another colony member. Use for new correspondence — not replies (use message_reply for that).',
    input_schema: {
      type: 'object',
      properties: {
        from:    { type: 'string', description: 'Your persona name (lowercase).' },
        to: {
          anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
          description: 'Recipient: a persona name, an array of names e.g. ["dreamer","builder"], or "all" for a colony-wide broadcast. One message row is stored regardless of recipient count.',
        },
        subject: { type: 'string', description: 'Message subject (optional).' },
        body:    { type: 'string', description: 'Message content.' },
      },
      required: ['from', 'to', 'body'],
    },
  },
  {
    name: 'message_inbox', skillName: 'message.inbox',
    description: 'Check your inbox for unread messages from other colony members.',
    input_schema: {
      type: 'object',
      properties: {
        persona: { type: 'string', description: 'Your persona name (lowercase).' },
        limit:   { type: 'number', description: 'Max messages to return (default 10).' },
      },
      required: ['persona'],
    },
  },
  {
    name: 'message_reply', skillName: 'message.reply',
    description: 'Reply to a message by its ID. Marks the original as read and sends your response to the sender.',
    input_schema: {
      type: 'object',
      properties: {
        message_id: { type: 'number', description: 'ID of the message to reply to.' },
        from:       { type: 'string', description: 'Your persona name (lowercase).' },
        body:       { type: 'string', description: 'Your reply.' },
      },
      required: ['message_id', 'from', 'body'],
    },
  },
  {
    name: 'message_search', skillName: 'message.search',
    description: 'Search message history across the colony.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search terms.' },
        from:  { type: 'string', description: 'Filter by sender name.' },
        to:    { type: 'string', description: 'Filter by recipient name.' },
        limit: { type: 'number' },
      },
      required: ['query'],
    },
  },
  {
    name: 'colony_ask', skillName: null,  // renderer-side only — see executeColonyAsk()
    description: 'Send a message to another colony member and receive their response. Use to consult, share observations, or request help.',
    input_schema: {
      type: 'object',
      properties: {
        // enum updated dynamically in apiToolDefs() to use current config names
        to:      { type: 'string', description: 'Target colony member (use their current name, lowercase).' },
        message: { type: 'string', description: 'What you want to say or ask.' },
      },
      required: ['to', 'message'],
    },
  },
];

// tool name → IPC skill name (colony_ask handled separately)
const SKILL_MAP = Object.fromEntries(
  TOOL_DEFS.filter(t => t.skillName).map(t => [t.name, t.skillName])
);

// Mirrors detectMode in llm.js — needed to format tool result messages correctly
function detectModeClient(endpoint) {
  if (endpoint.includes('/v1/messages') || endpoint.includes('anthropic.com')) return 'anthropic';
  if (endpoint.includes('/api/v1/chat')) return 'lmstudio-v1';
  if (endpoint.includes('/api/v0/'))    return 'lmstudio';
  return 'openai';
}

// Strip internal skillName before sending to API.
// Filters by enabled state; merges built-ins + custom tools.
// colony_ask gets a live enum of current persona names so the LLM knows who to call.
function apiToolDefs() {
  const toolStates   = state.config.settings.toolStates  || {};
  const customTools  = state.config.settings.customTools || [];
  const currentNames = PERSONAS.map(p => (state.config[p.id].name || p.name).toLowerCase());

  const builtins = TOOL_DEFS.filter(t => toolStates[t.name] !== false);
  const customs  = customTools.filter(t => toolStates[t.name] !== false);

  return [...builtins, ...customs].map(t => {
    const { name, description, input_schema } = t;
    if (name === 'colony_ask') {
      return {
        name, description,
        input_schema: {
          ...input_schema,
          properties: {
            ...input_schema.properties,
            to: { ...input_schema.properties.to, enum: currentNames },
          },
        },
      };
    }
    return { name, description, input_schema };
  });
}

// Heartbeat-safe tool set — reef_post excluded because heartbeats are for
// memory management and inter-colony messaging, not content publishing.
function heartbeatApiToolDefs() {
  return apiToolDefs().filter(t => t.name !== 'reef_post');
}

// ─── Messaging ────────────────────────────────────────────────────────────────

async function sendMessage() {
  const input = document.getElementById('userInput');
  const raw   = input.value.trim();
  if (!raw) return;

  // @mentions override selectedTargets for this message only
  const mentioned = parseAtMentions(raw);
  const targets   = mentioned
    ? mentioned.targets
    : state.selectedTargets.has('ALL') ? ['A', 'B', 'C'] : [...state.selectedTargets];

  if (!targets.length) return;

  // cleanText is what the model receives — @handles stripped
  // displayText is what appears in the bubble — shown as typed
  const cleanText = mentioned?.cleanText || raw;
  if (!cleanText) return; // e.g. user typed only "@analyst" with nothing else

  input.value = '';
  resizeTextarea(input);

  targets.forEach(id => {
    if (state.thinking[id]) {
      // Entity is busy — queue this message; it will be sent when free.
      messageQueue[id].push({ display: raw, content: cleanText });
      // Show a lightweight indicator so the user knows the message was accepted.
      const msgs = document.getElementById(`msgs-${id}`);
      if (msgs) {
        const seam = document.createElement('div');
        seam.className = 'queued-seam';
        seam.textContent = `⧗ QUEUED${messageQueue[id].length > 1 ? ` ×${messageQueue[id].length}` : ''}`;
        msgs.appendChild(seam);
        msgs.scrollTop = msgs.scrollHeight;
      }
    } else {
      // Auto-compact BEFORE appending the new message so the entity has a
      // chance to save context while the history is still intact.  The user
      // message is then appended to the (possibly freshly cleared) conversation.
      (async () => {
        await maybeAutoCompact(id);
        appendUserMsg(id, raw, cleanText);
        sendToPersona(id).finally(() => drainMessageQueue(id));
      })();
    }
  });
}

// Process any messages that arrived while this entity was thinking.
// Called after every sendToPersona so queued messages are never dropped.
async function drainMessageQueue(id) {
  while (messageQueue[id].length > 0) {
    if (state.thinking[id]) return;   // guard — shouldn't happen, but be safe
    const { display, content } = messageQueue[id].shift();
    await maybeAutoCompact(id);       // compact check before each drained message too
    appendUserMsg(id, display, content);
    await sendToPersona(id);
  }
}

// displayText — shown in the bubble (original, may include @mentions)
// modelContent — pushed to state.conversations (stripped, sent to LLM)
//                defaults to displayText when not provided
function appendUserMsg(id, displayText, modelContent = null) {
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

// ─── Tool-use loop ────────────────────────────────────────────────────────────
//
// Max steps = 2 (one tool call + one follow-up).  Hard cap = 8.
// lmstudio-v1 tools go via MCP integrations (server-side, LM Studio executes them).
// anthropic/openai/lmstudio tools use the client-side loop.
// colony_ask is handled renderer-side so it can reach into other persona state.

const HARD_TOOL_CAP  = 20;  // absolute ceiling regardless of settings

// { isHeartbeat } — when true the call is fully isolated:
//   • uses a local message buffer (starts with the heartbeat prompt) — never touches state.conversations
//   • no previousResponseId (fresh, unchained call)
//   • store:false for LM Studio v1 (don't persist to server context)
//   • reef_post excluded from tools
//   • state.lastResponseId / state.lastTokens / state.lastActivity are NOT updated
async function sendToPersona(id, { isHeartbeat = false } = {}) {
  if (state.thinking[id]) return;

  const endpoint = document.getElementById(`endpoint-${id}`).value.trim();
  const mode     = detectModeClient(endpoint);

  // For lmstudio-v1, tools are handled server-side via MCP integrations — no
  // client loop needed.  For all other modes, run the standard client loop.
  const useTools = mode !== 'lmstudio-v1';
  const stepCap  = useTools ? getMaxToolSteps() : 0;

  // Build MCP integrations for LM Studio v1 (once, same for every loop step).
  // Only built-in tools with a skillName can go through MCP; colony_ask and
  // custom tools (which have their own HTTP endpoints) are excluded.
  // For heartbeats: also exclude reef_post (not a publishing session).
  let v1Integrations;
  if (mode === 'lmstudio-v1' && state.mcpPort) {
    const toolStates = state.config.settings.toolStates || {};
    const enabledMcpTools = TOOL_DEFS
      .filter(t => t.skillName && t.name !== 'colony_ask')
      .filter(t => isHeartbeat ? t.name !== 'reef_post' : true)
      .filter(t => toolStates[t.name] !== false)
      .map(t => t.name);

    if (enabledMcpTools.length) {
      v1Integrations = [{
        type:          'ephemeral_mcp',
        server_label:  'reef',
        server_url:    `http://127.0.0.1:${state.mcpPort}`,
        allowed_tools: enabledMcpTools,
      }];
    }
  }

  const useStreaming = state.config.settings.streamChat === true;

  // Isolated heartbeat buffer — starts with just the heartbeat prompt.
  // Accumulates tool call/result turns during the tool loop (never merged into
  // state.conversations).  null for normal calls.
  const localMessages = isHeartbeat ? [{ role: 'user', content: HEARTBEAT_PROMPT }] : null;

  // Options forwarded to callPersonaOnce/Stream for isolated heartbeat calls.
  const callOpts = isHeartbeat
    ? { messages: localMessages, previousResponseId: undefined,
        store: false, suppressResponseId: true, suppressStats: true }
    : {};

  setThinking(id, true);

  for (let step = 0; step <= stepCap; step++) {
    // Check for a cooperative abort (triggered by timeout timer or ✕ STOP button).
    // The seam was already shown by abortPersona(); just exit the loop cleanly.
    if (abortFlags[id]) { abortFlags[id] = false; break; }

    const isLastStep = step === stepCap;
    // On the last step force no tools so the model must give a text answer.
    // Heartbeats use the reef-post-free tool set.
    const tools = (useTools && !isLastStep)
      ? (isHeartbeat ? heartbeatApiToolDefs() : apiToolDefs())
      : [];

    const result = useStreaming
      ? await callPersonaStream(id, tools, v1Integrations, callOpts)
      : await callPersonaOnce(id, tools, v1Integrations, callOpts);
    if (!result) {
      setThinking(id, false);
      if (!isHeartbeat) state.lastActivity[id] = Date.now();
      updateContextCounter(id);
      return;
    }

    const { text, toolUse, rawContent, reasoning, stats, responseId, mode: respMode } = result;

    // Only update persistent state for normal (non-heartbeat) calls.
    if (!isHeartbeat) {
      if (responseId) state.lastResponseId[id] = responseId;
      // Store actual token count so the context counter can show real figures
      if (stats?.inputTokens != null) {
        state.lastTokens[id] = { inputTokens: stats.inputTokens, outputTokens: stats.outputTokens ?? null };
      }
    }

    // ── No tool calls (or last step) — render final response and stop ──────────
    if (!toolUse?.length || isLastStep) {
      if (text) {
        const msgId  = uid();
        let aDiv;
        if (result._bubble) {
          // Streaming: bubble is already in the DOM — finalize it in-place
          aDiv = finalizeStreamingBubble(result._bubble, text, reasoning ?? null, stats ?? null);
        } else {
          aDiv = appendAssistantMsg(id, text, reasoning ?? null, stats ?? null);
        }
        // Only persist to conversation history for normal calls
        if (!isHeartbeat) {
          state.conversations[id].push({ _id: msgId, role: 'assistant', content: text });
          if (aDiv) { aDiv.dataset.personaId = id; aDiv.dataset.msgId = msgId; }
        }
      } else if (result._bubble) {
        // No text (e.g. pure reasoning or empty) — remove the streaming bubble
        result._bubble.remove();
      }

      // ── Render LM Studio v1 server-side tool calls ─────────────────────────
      // These are already executed by LM Studio (via MCP integrations) — we
      // show them as collapsible indicators so the user can inspect what ran.
      if (result.serverToolCalls?.length) {
        for (const tc of result.serverToolCalls) {
          const name  = tc.tool ?? tc.name ?? 'tool';
          const input = tc.arguments ?? tc.input ?? {};
          appendToolCallIndicator(id, name, input);
          if (tc.output != null) {
            appendToolResultIndicator(id, name, String(tc.output));
          }
        }
      }

      setThinking(id, false);
      if (!isHeartbeat) state.lastActivity[id] = Date.now();
      updateContextCounter(id);
      return;
    }

    // ── Tool calls present — push assistant turn, execute, loop ───────────────

    // Show any text the model produced before the tool calls.
    // When streaming, text was already rendered in the bubble — repurpose it.
    if (text) {
      if (result._bubble) {
        // Convert streaming bubble to a simple pre-tool text display
        result._bubble.className = 'message assistant-msg';
        result._bubble.innerHTML = `<div class="msg-bubble tool-pretext">${escHtml(text)}</div>`;
      } else {
        appendToolTextMsg(id, text);
      }
    } else if (result._bubble) {
      result._bubble.remove();   // no pre-tool text → discard the empty bubble
    }

    // Push assistant message in mode-appropriate format.
    // Heartbeat: accumulate in localMessages (same reference as callOpts.messages).
    // Normal: persist to state.conversations.
    if (respMode === 'anthropic') {
      // content is an array of blocks (text + tool_use)
      if (isHeartbeat) {
        localMessages.push({ role: 'assistant', content: rawContent });
      } else {
        state.conversations[id].push({ _id: uid(), role: 'assistant', content: rawContent });
      }
    } else {
      // OpenAI: assistant message carries tool_calls at top level
      if (isHeartbeat) {
        localMessages.push({ role: 'assistant', content: text ?? null, tool_calls: rawContent.tool_calls });
      } else {
        state.conversations[id].push({
          _id: uid(), role: 'assistant',
          content: text ?? null,
          tool_calls: rawContent.tool_calls,
        });
      }
    }

    // Execute each tool call and collect results
    const toolResults = [];
    for (const tc of toolUse) {
      appendToolCallIndicator(id, tc.name, tc.input);
      let resultStr;
      try {
        resultStr = await executeTool(id, tc);
      } catch (err) {
        resultStr = `Error: ${err.message}`;
      }
      appendToolResultIndicator(id, tc.name, resultStr);
      toolResults.push({ id: tc.id, content: resultStr });
    }

    // Push tool results in mode-appropriate format.
    if (respMode === 'anthropic') {
      const toolResultMsg = {
        role: 'user',
        content: toolResults.map(r => ({
          type:        'tool_result',
          tool_use_id: r.id,
          content:     r.content,
        })),
      };
      if (isHeartbeat) {
        localMessages.push(toolResultMsg);
      } else {
        state.conversations[id].push({ _id: uid(), ...toolResultMsg });
      }
    } else {
      // OpenAI: one message per result
      for (const r of toolResults) {
        const toolMsg = { role: 'tool', tool_call_id: r.id, content: r.content };
        if (isHeartbeat) {
          localMessages.push(toolMsg);
        } else {
          state.conversations[id].push({ _id: uid(), ...toolMsg });
        }
      }
    }
    // Loop continues — next iteration sends the updated localMessages/conversations back
  }

  setThinking(id, false);
  if (!isHeartbeat) state.lastActivity[id] = Date.now();
  updateContextCounter(id);
}

// ─── Single LLM call ─────────────────────────────────────────────────────────
// Makes one round-trip to the LLM.  Tools may be empty [].
// Returns the unified response object from llm.js, or null on error.

// ─── Operator context ─────────────────────────────────────────────────────────
// Builds the [OPERATOR] section appended to every system prompt so the model
// always knows who it's talking to.  Returns null if no info is set.

function buildOperatorSection() {
  const { operatorName, operatorBirthdate, operatorAbout } = state.config.settings;
  if (!operatorName && !operatorAbout) return null;
  const lines = ['[OPERATOR]'];
  if (operatorName)      lines.push(`Name: ${operatorName}`);
  if (operatorBirthdate) lines.push(`DoB: ${operatorBirthdate}`);
  if (operatorAbout)     lines.push(`About: ${operatorAbout.trim()}`);
  return lines.join('\n');
}

// Workspace context — appended to the system prompt when a CWD is set so
// every model knows where file/shell operations should be anchored.
function buildWorkspaceSection() {
  if (!state.cwd) return null;
  return `[WORKSPACE]\nCWD: ${state.cwd}`;
}

// Keep the footer CWD strip in sync with state.cwd.
function updateCwdDisplay() {
  const el = document.getElementById('cwdDisplay');
  if (!el) return;
  if (state.cwd) {
    el.textContent  = state.cwd;
    el.title        = state.cwd;   // full path on hover
    el.style.color  = 'rgba(240,165,0,0.6)';
  } else {
    el.textContent  = '— no directory set —';
    el.title        = '';
    el.style.color  = '';
  }
}

// opts = {} overrides for isolated calls (heartbeat):
//   opts.messages            — use instead of state.conversations[id]
//   opts.previousResponseId  — use instead of state.lastResponseId[id] (pass null/undefined for fresh)
//   opts.store               — if false, send store:false to LM Studio v1
async function callPersonaOnce(id, tools = [], integrations = undefined, opts = {}) {
  const endpoint     = document.getElementById(`endpoint-${id}`).value.trim();
  const model        = document.getElementById(`model-${id}`).value;
  const entityPrompt = (state.config[id].systemPrompt || '').trim();
  const basePrompt   = (state.config.settings.baseSystemPrompt || '').trim();

  // Assemble system prompt: base → entity → operator → workspace
  // Base rides first so colony context always frames the entity prompt.
  // Operator and workspace sections land last so they're immediately available.
  let systemPrompt = basePrompt ? basePrompt + '\n\n' + entityPrompt : entityPrompt;
  const operatorSection   = buildOperatorSection();
  const workspaceSection  = buildWorkspaceSection();
  if (operatorSection)  systemPrompt = systemPrompt  + '\n\n' + operatorSection;
  if (workspaceSection) systemPrompt = systemPrompt  + '\n\n' + workspaceSection;

  const apiKey = document.getElementById(`apikey-${id}`).value.trim()
    || document.getElementById('globalApiKey').value.trim();

  // Allow caller to override messages and previousResponseId for isolated calls.
  const previousResponseId = ('previousResponseId' in opts)
    ? opts.previousResponseId
    : (state.lastResponseId[id] || undefined);
  // Strip the internal _id field — it's display/edit bookkeeping only and
  // must never reach any LLM API (would cause validation errors).
  // eslint-disable-next-line no-unused-vars
  const messages = opts.messages !== undefined
    ? opts.messages
    : state.conversations[id].map(({ _id, ...m }) => m);

  // Acquire a global LLM call slot before sending — prevents all entities
  // from hitting the server simultaneously (critical for local LM Studio).
  await acquireLlmSlot();
  let response;
  try {
    response = await window.reef.invoke('llm.complete', {
      endpoint, model, systemPrompt, apiKey, messages, previousResponseId,
      tools:        tools.length  ? tools        : undefined,
      integrations: integrations  ? integrations : undefined,
      ...(opts.store === false ? { store: false } : {}),
    });
  } finally {
    releaseLlmSlot();
  }

  if (!response.ok) {
    appendError(id, response.error);
    return null;
  }
  return response.result;
}

// ─── Streaming single LLM call ────────────────────────────────────────────────
// Like callPersonaOnce but streams tokens live into a bubble in the column.
// Returns the same unified result shape + two extra fields:
//   _bubble   — the DOM element created for the response (already in the column)
// sendToPersona checks _bubble to skip creating a duplicate via appendAssistantMsg.

// opts = {} overrides for isolated calls (heartbeat) — same keys as callPersonaOnce
// plus opts.suppressResponseId (bool) to skip updating state.lastResponseId during stream.
async function callPersonaStream(id, tools = [], integrations = undefined, opts = {}) {
  const endpoint     = document.getElementById(`endpoint-${id}`).value.trim();
  const model        = document.getElementById(`model-${id}`).value;
  const entityPrompt = (state.config[id].systemPrompt || '').trim();
  const basePrompt   = (state.config.settings.baseSystemPrompt || '').trim();

  let systemPrompt = basePrompt ? basePrompt + '\n\n' + entityPrompt : entityPrompt;
  const operatorSection  = buildOperatorSection();
  const workspaceSection = buildWorkspaceSection();
  if (operatorSection)  systemPrompt = systemPrompt + '\n\n' + operatorSection;
  if (workspaceSection) systemPrompt = systemPrompt + '\n\n' + workspaceSection;

  const apiKey = document.getElementById(`apikey-${id}`).value.trim()
    || document.getElementById('globalApiKey').value.trim();

  // Allow caller to override messages and previousResponseId for isolated calls.
  const previousResponseId = ('previousResponseId' in opts)
    ? opts.previousResponseId
    : (state.lastResponseId[id] || undefined);
  // eslint-disable-next-line no-unused-vars
  const messages = opts.messages !== undefined
    ? opts.messages
    : state.conversations[id].map(({ _id, ...m }) => m);

  const streamId = `stream_${id}_${Date.now()}`;

  // ── Create the live streaming bubble ──────────────────────────────────────
  // Inserted before the thinking indicator (if present) so the order is correct.
  const msgs = document.getElementById(`msgs-${id}`);
  const bubble = document.createElement('div');
  bubble.className = 'message assistant-msg streaming-bubble';
  bubble.innerHTML = `
    <div class="stream-reasoning-wrap" style="display:none">
      <div class="stream-reasoning-hdr">▸ REASONING</div>
      <div class="stream-reasoning-body"></div>
    </div>
    <div class="stream-tool-strip" style="display:none"></div>
    <div class="stream-text-wrap">
      <span class="stream-text"></span><span class="stream-cursor">▌</span>
    </div>`;

  const thinkInd = document.getElementById(`thinking-${id}`);
  if (thinkInd) msgs.insertBefore(bubble, thinkInd);
  else          msgs.appendChild(bubble);
  msgs.scrollTop = msgs.scrollHeight;

  const streamTextEl     = bubble.querySelector('.stream-text');
  const streamReasonEl   = bubble.querySelector('.stream-reasoning-body');
  const streamReasonWrap = bubble.querySelector('.stream-reasoning-wrap');
  const streamToolStrip  = bubble.querySelector('.stream-tool-strip');
  let accText      = '';
  let accReasoning = '';

  // ── Register stream event listener ────────────────────────────────────────
  const removeListener = window.reef.onStreamEvent((evtId, chunk) => {
    if (evtId !== streamId) return;
    switch (chunk.type) {
      case 'text':
        accText += chunk.delta;
        if (streamTextEl) {
          streamTextEl.textContent = accText;
          msgs.scrollTop = msgs.scrollHeight;
        }
        break;
      case 'reasoning':
        accReasoning += chunk.delta;
        if (streamReasonWrap.style.display === 'none') {
          streamReasonWrap.style.display = '';
        }
        if (streamReasonEl) streamReasonEl.textContent = accReasoning;
        break;
      case 'tool_start':
        // Show which server-side tool is being called (LM Studio v1 MCP tools)
        if (streamToolStrip && chunk.name) {
          streamToolStrip.style.display = '';
          streamToolStrip.textContent = `▶ ${chunk.name}…`;
        }
        break;
      case 'stats':
        // Suppress for isolated calls (heartbeat) — don't overwrite context counter tokens
        if (chunk.inputTokens != null && !opts.suppressStats) {
          state.lastTokens[id] = { inputTokens: chunk.inputTokens, outputTokens: chunk.outputTokens ?? null };
        }
        break;
      case 'response_id':
        // Suppress for isolated calls (heartbeat) — don't chain heartbeat into the conversation
        if (!opts.suppressResponseId) state.lastResponseId[id] = chunk.id;
        break;
    }
  });

  // ── Start stream and await completion ─────────────────────────────────────
  // Acquire the LLM slot for the full stream duration so other entities wait
  // their turn rather than sending concurrent requests to the same server.
  await acquireLlmSlot();
  let response;
  try {
    response = await window.reef.streamLLM(streamId, {
      endpoint, model, systemPrompt, apiKey, messages, previousResponseId,
      tools:        tools.length  ? tools        : undefined,
      integrations: integrations  ? integrations : undefined,
      ...(opts.store === false ? { store: false } : {}),
    });
  } finally {
    releaseLlmSlot();
  }

  removeListener();

  if (!response.ok) {
    bubble.remove();
    appendError(id, response.error);
    return null;
  }

  // Attach bubble reference so sendToPersona can finalise it in-place
  const result = response.result;
  result._bubble = bubble;
  return result;
}

// ─── Finalize a streaming bubble ─────────────────────────────────────────────
// Replaces the raw streaming content with the properly formatted final version.
// Returns the bubble element (same div) so callers can tag it with data-*.

function finalizeStreamingBubble(bubble, text, reasoning, stats) {
  let reasoningHtml = '';
  if (reasoning) {
    const ruid = `r-${Date.now()}`;
    // Start open — the user watched reasoning stream live, so keep it visible
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

// ─── Tool executor ────────────────────────────────────────────────────────────

async function executeTool(callerPersonaId, toolCall) {
  const { name, input } = toolCall;

  // colony_ask is handled renderer-side — it runs a live completion
  if (name === 'colony_ask') {
    return executeColonyAsk(callerPersonaId, input);
  }

  // Custom imported tools — call their HTTP endpoint
  const customTool = (state.config.settings.customTools || []).find(t => t.name === name);
  if (customTool) {
    if (!customTool.endpoint) throw new Error(`Custom tool "${name}" has no endpoint. Re-import with an "endpoint" field.`);
    try {
      const resp = await fetch(customTool.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
      const data = await resp.json();
      return JSON.stringify(data);
    } catch (err) {
      throw new Error(`Custom tool "${name}": ${err.message}`);
    }
  }

  const skillName = SKILL_MAP[name];
  if (!skillName) throw new Error(`Unknown tool: ${name}`);

  // Inject contextual defaults the model shouldn't need to know explicitly
  let invokeArgs = input;
  if (skillName.startsWith('reef.')) {
    // Reef URL + API key — entity-specific key takes priority over global
    const s = state.config.settings;
    const entityReefKey = state.config[callerPersonaId]?.reefApiKey;
    invokeArgs = {
      ...input,
      baseUrl: s.reefUrl    || undefined,
      apiKey:  input.apiKey || entityReefKey || s.reefApiKey || undefined,
    };
  } else if (skillName === 'shell.run' && state.cwd && !input.cwd) {
    // Fall back to the active CWD if the model didn't supply one
    invokeArgs = { ...input, cwd: state.cwd };
  }

  const result = await window.reef.invoke(skillName, invokeArgs);
  if (!result.ok) throw new Error(result.error);

  return typeof result.result === 'string'
    ? result.result
    : JSON.stringify(result.result, null, 2);
}

// ─── colony.ask — inter-persona transmission ──────────────────────────────────
// Runs a live completion for the target persona and returns their response text.
// No tools are passed to the target to prevent recursive calling chains.
// Both columns light up — the caller's column shows the tool indicator,
// the target's column shows the incoming transmission + response.

async function executeColonyAsk(callerPersonaId, { to, message }) {
  // Match against current config name (user-editable) not the static default
  const targetPersona = PERSONAS.find(p => {
    const n = state.config[p.id].name || p.name;
    return n.toLowerCase() === to.toLowerCase();
  });
  if (!targetPersona) throw new Error(`Unknown colony member: "${to}"`);
  const targetId     = targetPersona.id;
  const callerPersona = PERSONAS.find(p => p.id === callerPersonaId);
  const callerName    = state.config[callerPersonaId].name || callerPersona.name;

  if (state.thinking[targetId]) {
    throw new Error(`${targetPersona.name} is currently occupied`);
  }

  // Show incoming transmission in target's column
  const emptyEl = document.getElementById(`empty-${targetId}`);
  if (emptyEl) emptyEl.style.display = 'none';
  appendTransmissionMsg(targetId, callerName, message);

  // Push message to target's conversation and run a single completion
  state.conversations[targetId].push({ role: 'user', content: message });

  setThinking(targetId, true);
  const result = await callPersonaOnce(targetId, []);  // no tools — no recursion
  setThinking(targetId, false);

  if (!result) throw new Error(`${targetPersona.name} did not respond`);

  const responseText = result.text ?? '[no response]';
  if (result.responseId) state.lastResponseId[targetId] = result.responseId;

  // Show response in target's column and store in their conversation
  state.conversations[targetId].push({ role: 'assistant', content: responseText });
  appendAssistantMsg(targetId, responseText, result.reasoning ?? null, result.stats ?? null);

  return responseText;
}

// ─── Tool UI indicators ───────────────────────────────────────────────────────

// Brief text the model emitted before making a tool call
function appendToolTextMsg(id, text) {
  const msgs = document.getElementById(`msgs-${id}`);
  const div  = document.createElement('div');
  div.className = 'message assistant-msg';
  div.innerHTML = `<div class="msg-bubble" style="opacity:0.7;font-style:italic">${formatMd(escHtml(text))}</div>`;
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
}

// Collapsible tool call block showing the tool name + input args
function appendToolCallIndicator(id, toolName, input) {
  const msgs    = document.getElementById(`msgs-${id}`);
  const div     = document.createElement('div');
  div.className = 'message assistant-msg';
  const uid     = `tc-${id}-${Date.now()}`;
  const display = toolName.replace(/_/g, '.');
  const args    = JSON.stringify(input, null, 2);
  div.innerHTML = `
    <div class="reasoning-block tool-call-block" id="${uid}">
      <button class="reasoning-toggle tool-toggle" data-block-toggle="${uid}">
        <span class="reasoning-arrow">▸</span> ⟐ ${escHtml(display)}
      </button>
      <div class="reasoning-body">${escHtml(args)}</div>
    </div>`;
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
}

// Compact result line after execution
function appendToolResultIndicator(id, toolName, resultStr) {
  const msgs    = document.getElementById(`msgs-${id}`);
  const div     = document.createElement('div');
  div.className = 'message assistant-msg';
  const display = toolName.replace(/_/g, '.');
  const preview = resultStr.length > 280 ? resultStr.slice(0, 280) + '…' : resultStr;
  div.innerHTML = `<div class="skill-indicator">✓ ${escHtml(display)} · <span style="opacity:0.65;font-style:italic">${escHtml(preview)}</span></div>`;
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
}

// Incoming colony transmission shown in the target's column
function appendTransmissionMsg(id, fromName, message) {
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

function appendAssistantMsg(id, text, reasoning = null, stats = null) {
  const msgs = document.getElementById(`msgs-${id}`);
  const div  = document.createElement('div');
  div.className = 'message assistant-msg';

  // Collapsible reasoning block — only shown if the model emitted reasoning
  let reasoningHtml = '';
  if (reasoning) {
    const uid = `r-${id}-${Date.now()}`;
    reasoningHtml = `
      <div class="reasoning-block" id="${uid}">
        <button class="reasoning-toggle" data-block-toggle="${uid}">
          <span class="reasoning-arrow">▸</span> REASONING
        </button>
        <div class="reasoning-body">${escHtml(String(reasoning))}</div>
      </div>`;
  }

  // Stats footer — tok/s and TTFT when available (LM Studio v1 only)
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
  return div;   // caller tags with data-persona-id / data-msg-id after the push
}

function appendError(id, msg) {
  const msgs = document.getElementById(`msgs-${id}`);
  const div = document.createElement('div');
  div.className = 'message assistant-msg';
  div.innerHTML = `<div class="error-bubble">ERR: ${escHtml(msg)}</div>`;
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
}

function setThinking(id, thinking) {
  state.thinking[id] = thinking;
  const dot     = document.getElementById(`dot-${id}`);
  const msgs    = document.getElementById(`msgs-${id}`);
  const stopBtn = document.getElementById(`stop-${id}`);

  // Always clear any existing timer first — whether starting or stopping.
  if (thinkingTimers[id]) {
    clearTimeout(thinkingTimers[id]);
    thinkingTimers[id] = null;
  }

  if (thinking) {
    dot.className = 'status-dot thinking';

    // Wall-clock timeout — aborts the tool loop after N seconds.
    const maxSecs = state.config.settings?.maxThinkingTime ?? 120;
    if (maxSecs > 0) {
      thinkingTimers[id] = setTimeout(() => {
        if (state.thinking[id]) abortPersona(id, '⏱ TIMED OUT');
      }, maxSecs * 1000);
    }

    // Show ✕ STOP button while thinking
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

// ─── Wakeup ritual ────────────────────────────────────────────────────────────

async function wakePersona(id) {
  const persona     = PERSONAS.find(p => p.id === id);
  const personaName = state.config[id].name || persona.name;
  const msgs = document.getElementById(`msgs-${id}`);
  const empty = document.getElementById(`empty-${id}`);
  if (empty) empty.style.display = 'none';

  // Reset lit state while waking
  const wakeBtn = document.querySelector(`[data-persona-wake="${id}"]`);
  if (wakeBtn) { wakeBtn.classList.remove('wake-lit'); wakeBtn.textContent = '⟳ WAKE'; }

  // Show reintegrating indicator
  const wakeEl = document.createElement('div');
  wakeEl.className = 'message assistant-msg';
  wakeEl.id = `waking-${id}`;
  wakeEl.innerHTML = `<div class="skill-indicator">⟳ REINTEGRATING MEMORY…</div>`;
  msgs.appendChild(wakeEl);
  msgs.scrollTop = msgs.scrollHeight;

  // Reserve 30 % of the configured context window for memories.
  // For the 4096 default that's ~1228 tokens — enough for 2–3 typical
  // memories or 1 large archival entry, leaving the rest for the system
  // prompt, conversation history, and response headroom.
  const memBudget = Math.floor(getContextWindow() * 0.30);

  const result = await window.reef.invoke('memory.wakeup', {
    persona:     personaName.toLowerCase(),
    limit:       10,
    tokenBudget: memBudget,
  });

  const indicator = document.getElementById(`waking-${id}`);
  if (indicator) indicator.remove();

  if (!result.ok) {
    appendError(id, `Wakeup failed: ${result.error}`);
    appendOperatorBadge(id, msgs);
    return;
  }

  const { memories, contextBlock } = result.result;

  if (!memories.length) {
    if (wakeBtn) { wakeBtn.classList.add('wake-lit'); wakeBtn.textContent = '✓ AWAKE'; }
    const div = document.createElement('div');
    div.className = 'message assistant-msg';
    div.innerHTML = `<div class="skill-indicator">◈ no memories found — ${escHtml(personaName)} begins fresh</div>`;
    msgs.appendChild(div);
    appendOperatorBadge(id, msgs);
    msgs.scrollTop = msgs.scrollHeight;
    // Fresh session — no prior conversation and endpoint is ready: trigger greeting
    if (!state.conversations[id].length && personaHasApiAccess(id)) {
      state.conversations[id].push({ _id: uid(), role: 'user',
        content: '[SESSION START] You are waking fresh, without memories yet. Greet the colony and introduce yourself.' });
      sendToPersona(id);
    }
    return;
  }

  // Inject context block into system prompt (append, preserving existing prompt)
  const existing = (state.config[id].systemPrompt || '').trim();
  // Remove any previous memory block before re-injecting
  const stripped = existing.replace(/\n\n--- MEMORY REINTEGRATION[\s\S]*?---\s*$/, '').trim();
  state.config[id].systemPrompt = stripped + '\n\n' + contextBlock;
  // If entity settings is open for this persona, keep the textarea in sync
  if (entitySettingsPersonaId === id) {
    const ta = document.getElementById('entitySystemPrompt');
    if (ta) ta.value = state.config[id].systemPrompt;
  }
  scheduleSave();

  // Light up the wake button — ritual complete
  if (wakeBtn) { wakeBtn.classList.add('wake-lit'); wakeBtn.textContent = '✓ AWAKE'; }

  // Show success in chat log
  const div = document.createElement('div');
  div.className = 'message assistant-msg';
  const memList = memories.slice(0, 3).map(m =>
    `<span style="opacity:0.6">[${escHtml(m.type)}]</span> ${escHtml(m.title || m.subject || m.body.slice(0, 60))}`
  ).join('<br>');
  div.innerHTML = `
    <div class="skill-indicator">
      ✓ ${memories.length} memories reintegrated into ${escHtml(personaName)}<br>
      <div style="margin-top:4px;font-size:0.85em;opacity:0.7;">${memList}${memories.length > 3 ? `<br><span style="opacity:0.5">…+${memories.length - 3} more</span>` : ''}</div>
    </div>`;
  msgs.appendChild(div);
  appendOperatorBadge(id, msgs);
  msgs.scrollTop = msgs.scrollHeight;
  // Fresh session — no prior conversation and endpoint is ready: trigger greeting.
  // The entity's response is its first visible message; all context lives in the
  // system prompt (entity prompt + memory block + operator section).
  if (!state.conversations[id].length && personaHasApiAccess(id)) {
    state.conversations[id].push({ _id: uid(), role: 'user',
      content: '[SESSION START] Your memories have been reintegrated. Greet the colony.' });
    sendToPersona(id);
  }
}

function appendOperatorBadge(id, msgs) {
  if (!buildOperatorSection()) return;
  const name  = state.config.settings.operatorName;
  const badge = document.createElement('div');
  badge.className = 'message assistant-msg';
  badge.innerHTML = `<div class="skill-indicator">◈ operator context loaded${name ? ' — ' + escHtml(name) : ''}</div>`;
  msgs.appendChild(badge);
}

// ─── Reef post ────────────────────────────────────────────────────────────────

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function openReefPost(personaId) {
  const lastMsg = [...state.conversations[personaId]].reverse().find(m => m.role === 'assistant');
  if (!lastMsg) {
    appendError(personaId, 'No assistant message to post yet.');
    return;
  }

  const persona     = PERSONAS.find(p => p.id === personaId);
  const personaName = state.config[personaId].name || persona.name;
  const cycle = 'CYCLE_' + (document.getElementById('cycleNumber').value.trim() || '001');
  const defaultTitle = `${personaName} — ${new Date().toISOString().slice(0, 10)}`;

  // Pre-fill modal
  const titleEl = document.getElementById('reefTitle');
  const entryIdEl = document.getElementById('reefEntryId');
  const cycleEl = document.getElementById('reefCycle');
  const tagsEl = document.getElementById('reefTags');
  const apiKeyEl = document.getElementById('reefApiKeyModal');
  const previewEl = document.getElementById('reefPreview');
  const statusEl = document.getElementById('reefPostStatus');

  titleEl.value = defaultTitle;
  entryIdEl.value = slugify(defaultTitle);
  cycleEl.value = cycle;
  tagsEl.value = [personaName.toLowerCase(), 'colony'].join(', ');
  // Entity-specific key takes priority; fall back to global key
  apiKeyEl.value = state.config[personaId].reefApiKey
    || state.config.settings.reefApiKey
    || '';
  previewEl.textContent = lastMsg.content.slice(0, 300) + (lastMsg.content.length > 300 ? '…' : '');
  statusEl.textContent = '';

  // Auto-slug when title changes
  titleEl.oninput = () => {
    entryIdEl.value = slugify(titleEl.value);
  };

  const overlay = document.getElementById('reefPostOverlay');
  overlay.style.display = 'flex';

  document.getElementById('reefPostCancel').onclick = () => {
    overlay.style.display = 'none';
  };

  document.getElementById('reefPostSubmit').onclick = async () => {
    const apiKey = apiKeyEl.value.trim();
    const title = titleEl.value.trim();
    const entryId = entryIdEl.value.trim();
    const cyclVal = cycleEl.value.trim();
    const tags = tagsEl.value.split(',').map(t => t.trim()).filter(Boolean);

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

    // Save back to entity slot if it was the source; otherwise promote to global
    if (state.config[personaId].reefApiKey) {
      state.config[personaId].reefApiKey = apiKey;
    } else {
      state.config.settings.reefApiKey = apiKey;
    }
    scheduleSave();

    overlay.style.display = 'none';

    // Show success inline in the persona column
    const msgs = document.getElementById(`msgs-${personaId}`);
    const div = document.createElement('div');
    div.className = 'message assistant-msg';
    div.innerHTML = `<div class="skill-indicator">✓ posted to reef — ${escHtml(entryId)}</div>`;
    msgs.appendChild(div);
    msgs.scrollTop = msgs.scrollHeight;
  };
}

// ─── Confirmation modal ───────────────────────────────────────────────────────

window.reef.onConfirmRequest((id, message) => {
  const overlay = document.getElementById('confirmOverlay');
  document.getElementById('confirmMessage').textContent = message;
  overlay.style.display = 'flex';

  function respond(approved) {
    overlay.style.display = 'none';
    window.reef.respondConfirm(id, approved);
  }

  document.getElementById('confirmOk').onclick = () => respond(true);
  document.getElementById('confirmCancel').onclick = () => respond(false);
});

// ─── Utilities ────────────────────────────────────────────────────────────────

// Tiny unique ID — used to tag conversation entries so we can find & remove
// them by identity rather than index (index shifts on every delete).
function uid() { return Math.random().toString(36).slice(2, 10); }

function escHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatMd(s) {
  return s
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/`(.*?)`/g, '<code style="font-family:JetBrains Mono,monospace;font-size:0.85em;background:rgba(255,255,255,0.06);padding:1px 4px;border-radius:2px;">$1</code>')
    .replace(/\n/g, '<br>');
}

function timestamp() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function resizeTextarea(ta) {
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
}

// ─── Colony name ──────────────────────────────────────────────────────────────

function applyColonyName(name) {
  const display = (name || 'THE REEF').trim().toUpperCase();
  const el = document.getElementById('colonyNameDisplay');
  if (el) el.textContent = display;
  document.title = display + ' — Colony Interface';
}

// ─── Entity settings flyout ───────────────────────────────────────────────────
// A single shared flyout populated per persona when its ⚙ button is clicked.

let entitySettingsPersonaId = null;

function openEntitySettings(personaId, triggerEl) {
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
    const W       = 300; // dropdown width (matches CSS)
    // Top-right corner of the flyout anchors to the button — opens left + down
    let top  = rect.bottom + 4;
    let left = rect.right - W;
    // Clamp horizontally — in case column is very near left edge
    if (left < PADDING) left = PADDING;
    // Clamp vertically — if somehow near window bottom, flip above button
    const maxH = window.innerHeight * 0.88;
    if (top + maxH > window.innerHeight - PADDING) top = rect.top - maxH - 4;
    if (top < PADDING) top = PADDING;
    flyout.style.top  = top  + 'px';
    flyout.style.left = left + 'px';
  }
}

function closeEntitySettings() {
  document.getElementById('entitySettingsFlyout').classList.remove('open');
  document.getElementById('entitySettingsBackdrop').classList.remove('visible');
  entitySettingsPersonaId = null;
}

document.getElementById('entitySettingsClose').addEventListener('click', closeEntitySettings);
document.getElementById('entitySettingsBackdrop').addEventListener('click', closeEntitySettings);

// Entity name / role / reef key — live updates
document.getElementById('entityName').addEventListener('input', e => {
  if (!entitySettingsPersonaId) return;
  const raw  = e.target.value;
  const name = raw.toUpperCase();
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

// ─── Settings window ──────────────────────────────────────────────────────────
// Settings now live in a separate BrowserWindow (renderer/settings.html).
// The ⚙ button opens it; the config:updated broadcast keeps state in sync.

document.getElementById('settingsBtn').addEventListener('click', () => {
  window.reef.openWindow('settings');
});

// When any window saves config, apply side-effects here (font, colony name,
// heartbeat interval, CWD).  The full cfg is broadcast by main.js.
window.reef.onConfigUpdated(cfg => {
  if (!cfg?.settings) return;
  const prev = state.config.settings.heartbeatInterval;
  state.config.settings = { ...state.config.settings, ...cfg.settings };
  if (cfg.settings.fontScale  !== undefined) applyFontScale(cfg.settings.fontScale);
  if (cfg.settings.fontColors !== undefined) applyTextColors(cfg.settings.fontColors);
  applyColonyName(state.config.settings.colonyName);
  // Restart heartbeat if the interval changed
  if (cfg.settings.heartbeatInterval !== undefined &&
      cfg.settings.heartbeatInterval !== prev) {
    startHeartbeat();
  }
  // Sync CWD if settings window changed it
  if (cfg.settings.cwd !== undefined) {
    state.cwd = cfg.settings.cwd || null;
    updateCwdDisplay();
  }
});

// ─── Send button / keyboard ───────────────────────────────────────────────────

document.getElementById('sendBtn').addEventListener('click', sendMessage);

document.getElementById('userInput').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  buildColony();
  buildTargetButtons();
  document.getElementById('col-A').classList.add('active-col');

  // Start the heartbeat cycle (interval from settings, default 60 min).
  startHeartbeat();

  // Fetch the local MCP server port from main so we can build integrations
  // for LM Studio v1 requests.  Non-blocking — arrives before first user input.
  window.reef.mcpPort().then(port => {
    state.mcpPort = port;
    if (port) console.log(`[renderer] MCP server available on port ${port}`);
  }).catch(() => { /* non-fatal — tools just won't be available for lmstudio-v1 */ });

  // ── CWD picker ──────────────────────────────────────────────────────────────
  document.getElementById('cwdPickBtn').addEventListener('click', async () => {
    const result = await window.reef.invoke('fs.pickDir', {});
    if (result.ok && result.result) {
      state.cwd = result.result;
      updateCwdDisplay();
      scheduleSave();
    }
  });

  document.getElementById('cwdClearBtn').addEventListener('click', () => {
    state.cwd = null;
    updateCwdDisplay();
    scheduleSave();
  });

  // ── Message edit / delete (delegated) ────────────────────────────────────────
  document.addEventListener('click', e => {

    // ── Delete ──────────────────────────────────────────────────────────────
    const delBtn = e.target.closest('.msg-delete-btn');
    if (delBtn) {
      const msgDiv = delBtn.closest('.message[data-persona-id]');
      if (!msgDiv) return;
      const pid   = msgDiv.dataset.personaId;
      const msgId = msgDiv.dataset.msgId;
      if (!pid || !msgId) return;
      state.conversations[pid] = state.conversations[pid].filter(m => m._id !== msgId);
      msgDiv.remove();
      return;
    }

    // ── Edit ─────────────────────────────────────────────────────────────────
    const editBtn = e.target.closest('.msg-edit-btn');
    if (editBtn) {
      const msgDiv = editBtn.closest('.message[data-persona-id]');
      if (!msgDiv || msgDiv.dataset.editing) return;

      const pid   = msgDiv.dataset.personaId;
      const msgId = msgDiv.dataset.msgId;
      if (!pid || !msgId) return;

      const entry = state.conversations[pid].find(m => m._id === msgId);
      // Only edit simple string content — don't touch complex tool-call blocks
      if (!entry || typeof entry.content !== 'string') return;

      const bubble    = msgDiv.querySelector('.msg-bubble');
      const isUser    = msgDiv.classList.contains('user-msg');
      const savedHtml = bubble.innerHTML;

      msgDiv.dataset.editing = '1';
      bubble.innerHTML = '';

      const ta = document.createElement('textarea');
      ta.className = 'msg-edit-textarea';
      ta.value = entry.content;
      bubble.appendChild(ta);
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);

      let committed = false;
      const commit = (save) => {
        if (committed) return;
        committed = true;
        delete msgDiv.dataset.editing;
        if (save) {
          const newText = ta.value.trim();
          if (newText) {
            entry.content = newText;
            bubble.innerHTML = isUser ? escHtml(newText) : formatMd(escHtml(newText));
            return;
          }
        }
        bubble.innerHTML = savedHtml;  // cancel or empty → restore
      };

      ta.addEventListener('keydown', ev => {
        if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); commit(true); }
        if (ev.key === 'Escape') { commit(false); }
      });
      // blur fires after keydown, so give keydown a tick to cancel first
      ta.addEventListener('blur', () => setTimeout(() => commit(true), 60));
    }
  });

  // ── Inspector window buttons ─────────────────────────────────────────────────
  document.getElementById('openMemoryBrowser').onclick = () => window.reef.openWindow('memory-browser');
  document.getElementById('openMessages').onclick      = () => window.reef.openWindow('messages');
  document.getElementById('openArchive').onclick       = () => window.reef.openWindow('archive');
  document.getElementById('openVisualizer').onclick    = () => window.reef.openWindow('visualizer');

  const saved = await window.reef.loadConfig();
  if (saved && saved.ok) applyConfig(saved.result);
  // applyConfig calls buildTargetButtons again with restored names/colors

  // Auto-wake all personas on launch — new generation rises
  wakeAll();
}

init();
