// ─── Context management, token estimation, operator/workspace sections ───────

import { state, COMPACT_THRESHOLD, DEFAULT_CONTEXT_WINDOW } from './state.js';

// Injected callback — compactPersona lives in the orchestrator
let _compactPersona;
export function setCompactCallback(fn) { _compactPersona = fn; }

export function getContextWindow() {
  return state.config.settings?.contextWindow || DEFAULT_CONTEXT_WINDOW;
}

export async function maybeAutoCompact(id) {
  if (state.thinking[id]) return;
  const inToks  = state.lastTokens[id]?.inputTokens  ?? null;
  const outToks = state.lastTokens[id]?.outputTokens ?? null;
  const ctxWin  = getContextWindow();

  if (inToks != null) {
    const currentToks = inToks + (outToks ?? 0);
    if (currentToks >= ctxWin * 0.85) await _compactPersona(id);
  } else {
    if (state.conversations[id].length >= COMPACT_THRESHOLD) await _compactPersona(id);
  }
}

export const COMPACT_PROMPT =
`[COMPACT] Your context window has grown long. Before we continue, please save \
an archival memory summarising the key insights, decisions, and work from this \
session — use memory_save with type "archival" and a descriptive title. \
Once saved, reply with a brief confirmation.`;

export function estimateTokens(id) {
  let chars = (state.config[id]?.systemPrompt || '').length;
  const msgs = state.conversations[id];
  for (const m of msgs) {
    const c = m.content;
    if (typeof c === 'string') chars += c.length;
    else if (Array.isArray(c)) chars += JSON.stringify(c).length;
  }
  return Math.round(chars / 4);
}

export function updateContextCounter(id) {
  const el = document.getElementById(`ctx-${id}`);
  if (!el) return;

  const count   = state.conversations[id].length;

  if (!count) {
    el.textContent = '0';
    el.title       = '0 messages';
    el.style.color = '';
    return;
  }

  const inToks  = state.lastTokens[id]?.inputTokens  ?? null;
  const outToks = state.lastTokens[id]?.outputTokens ?? null;
  const maxCtx  = state.maxContext[id] ?? null;

  const hasActual = inToks != null;
  const toks      = hasActual ? inToks + (outToks ?? 0) : estimateTokens(id);
  const prefix    = hasActual ? '' : '~';

  const tokStr  = toks >= 1000 ? `${prefix}${(toks / 1000).toFixed(1)}k` : `${prefix}${toks}`;
  el.textContent = `${count} · ${tokStr}`;

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

// ─── Operator & workspace context ────────────────────────────────────────────

export function buildOperatorSection() {
  const { operatorName, operatorBirthdate, operatorAbout } = state.config.settings;
  if (!operatorName && !operatorAbout) return null;
  const lines = ['[OPERATOR]'];
  if (operatorName)      lines.push(`Name: ${operatorName}`);
  if (operatorBirthdate) lines.push(`DoB: ${operatorBirthdate}`);
  if (operatorAbout)     lines.push(`About: ${operatorAbout.trim()}`);
  return lines.join('\n');
}

export function buildWorkspaceSection() {
  if (!state.cwd) return null;
  if (state.projectContext) return state.projectContext;
  return `[WORKSPACE]\nCWD: ${state.cwd}`;
}

export async function scanProject(dir) {
  if (!dir) { state.projectContext = null; return; }
  try {
    const result = await window.reef.invoke('project.brief', { path: dir });
    state.projectContext = result.ok ? result.result : null;
  } catch {
    state.projectContext = null;
  }
}

export function updateCwdDisplay() {
  const el = document.getElementById('cwdDisplay');
  if (!el) return;
  if (state.cwd) {
    el.textContent  = state.cwd;
    el.title        = state.cwd;
    el.style.color  = 'rgba(240,165,0,0.6)';
  } else {
    el.textContent  = '— no directory set —';
    el.title        = '';
    el.style.color  = '';
  }
}

export function personaHasApiAccess(id) {
  const endpoint = document.getElementById(`endpoint-${id}`)?.value.trim();
  if (!endpoint) return false;
  const model = document.getElementById(`model-${id}`)?.value.trim();
  if (!model || model === 'custom') return false;
  if (/localhost|127\.0\.0\.1|0\.0\.0\.0|192\.168\.|10\.\d/.test(endpoint)) return true;
  const key = document.getElementById(`apikey-${id}`)?.value.trim()
    || document.getElementById('globalApiKey')?.value.trim();
  return !!key;
}
