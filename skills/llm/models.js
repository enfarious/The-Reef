'use strict';

const { getModelsUrl }  = require('./detect-mode');
const { fetchJsonGet }  = require('./http');

// ─── fetchModels ──────────────────────────────────────────────────────────────
// args: { endpoint, apiKey }
// Queries the model list endpoint (LM Studio /api/v0/models or OpenAI /v1/models).
// Returns [{ id, state, type, quantization, maxContext, arch }] — embedding models excluded.

async function fetchModels({ endpoint, apiKey }) {
  if (!endpoint) throw new Error('No endpoint configured.');

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
