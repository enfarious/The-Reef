'use strict';

// ─── LLM module facade ───────────────────────────────────────────────────────
// Re-exports the three public functions so that `require('./llm')` continues
// to work exactly as before — zero changes needed in skills/index.js or main.js.

const complete    = require('./complete');
const stream      = require('./stream');
const fetchModels = require('./models');

module.exports = { complete, stream, fetchModels };
