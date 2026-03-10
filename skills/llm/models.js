'use strict';

const { detectMode, getModelsUrl } = require('./detect-mode');
const { fetchJsonGet }             = require('./http');

// ─── Anthropic model catalogue ────────────────────────────────────────────────
// Anthropic has no /v1/models endpoint — return a static list instead.
// Keep this up-to-date when new models ship.

const ANTHROPIC_MODELS = [
  { id: 'claude-opus-4-20250514',    maxContext: 200000 },
  { id: 'claude-sonnet-4-20250514',  maxContext: 200000 },
  { id: 'claude-3-5-haiku-20241022', maxContext: 200000 },
  // Aliases — point at the same models, handy for quick selection
  { id: 'claude-opus-4.6',           maxContext: 200000 },
  { id: 'claude-sonnet-4.6',         maxContext: 200000 },
  { id: 'claude-3-5-haiku-latest',   maxContext: 200000 },
].map(m => ({
  id:           m.id,
  state:        'loaded',
  type:         'llm',
  quantization: null,
  maxContext:    m.maxContext,
  arch:         'claude',
}));

// ─── fetchModels ──────────────────────────────────────────────────────────────
// args: { endpoint, apiKey }
// Queries the model list endpoint (LM Studio /api/v0/models or OpenAI /v1/models).
// For Anthropic endpoints (including the local Claude CLI proxy), returns the
// static catalogue above — there is no models API to query.
// Returns [{ id, state, type, quantization, maxContext, arch }] — embedding models excluded.

async function fetchModels({ endpoint, apiKey }) {
  if (!endpoint) throw new Error('No endpoint configured.');
  if (endpoint === 'claude-cli') throw new Error('Claude CLI proxy is not ready. Run "claude login" and restart the app.');

  const mode = detectMode(endpoint);

  // Anthropic (direct or via claude-cli proxy) — no models endpoint exists
  if (mode === 'anthropic') {
    return ANTHROPIC_MODELS;
  }

  const modelsUrl = getModelsUrl(endpoint);
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const data = await fetchJsonGet(modelsUrl, headers);
  const raw  = Array.isArray(data) ? data : (data.data || []);

  return raw
    .filter(m => !m.type || m.type === 'llm' || m.type === 'vlm')
    .map(m => ({
      id:           m.id,
      state:        m.state             || 'unknown',
      type:         m.type              || 'llm',
      quantization: m.quantization      || null,
      maxContext:   m.max_context_length || null,
      arch:         m.arch              || null,
    }));
}

module.exports = fetchModels;
