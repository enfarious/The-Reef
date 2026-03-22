'use strict';

// ─── Mode detection ───────────────────────────────────────────────────────────
// Returns: 'anthropic' | 'openai' | 'lmstudio' | 'lmstudio-v1'
//
// lmstudio-v1  — /api/v1/chat  (LM Studio 0.4.0+, stateful, input/previous_response_id)
// lmstudio     — /api/v0/...   (LM Studio 0.3.6+, OpenAI-compat with richer metadata)
// openai       — /v1/...       (OpenAI or any OpenAI-compatible endpoint)
// anthropic    — /v1/messages  (Anthropic Claude API)

function detectMode(endpoint) {
  if (endpoint.includes('/v1/messages'))   return 'anthropic';
  if (endpoint.includes('anthropic.com'))  return 'anthropic';
  if (endpoint.includes('/api/v1/chat'))   return 'lmstudio-v1';
  if (endpoint.includes('/api/v0/'))       return 'lmstudio';
  return 'openai';
}

// ─── Models URL helper ────────────────────────────────────────────────────────

function getModelsUrl(endpoint) {
  const parsed = new URL(endpoint);
  const base = `${parsed.protocol}//${parsed.host}`;
  if (endpoint.includes('/api/v0/') || endpoint.includes('/api/v1/')) {
    return `${base}/api/v0/models`;  // model list is still on v0
  }
  return `${base}/v1/models`;
}

// ─── Model ID normalization ──────────────────────────────────────────────────
// Anthropic OAuth rejects dot-style aliases (claude-opus-4.6) — normalize to
// dash form (claude-opus-4-6).  Also fixes the old haiku ID.

const MODEL_ALIASES = {
  'claude-opus-4.6':            'claude-opus-4-6',
  'claude-sonnet-4.6':          'claude-sonnet-4-6',
  'claude-3-5-haiku-20241022':  'claude-haiku-4-5-20251001',
  'claude-3-5-haiku-latest':    'claude-haiku-4-5-latest',
};

function normalizeModel(model) {
  return MODEL_ALIASES[model] || model;
}

module.exports = { detectMode, getModelsUrl, normalizeModel };
