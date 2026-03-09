'use strict';

// ─── Trust — Source Reliability Weights ───────────────────────────────────────
//
// Every memory write carries a source ID and a trust weight.  Trust weights
// determine how confidently we accept facts and how heavily we weight graph edges.
//
// Base weights (from the design doc):
//   Mike (direct):              1.0  — ground truth
//   Persona (direct observe):   0.7  — high confidence, first-hand
//   Persona (inference):        0.5  — moderate confidence, derived
//   Persona (speculation):      0.3  — low confidence, exploratory
//   Corroborated (2+ sources):  +0.2 bonus
//
// Weights are seeded into lb_sources at startup.  load() reads the DB into the
// in-memory cache so runtime lookups stay synchronous.

const { pool } = require('./db');

// ─── Default weights ──────────────────────────────────────────────────────────

const DEFAULTS = {
  mike:      1.0,
  operator:  1.0,
  dreamer:   0.7,
  builder:   0.7,
  librarian: 0.7,
  system:    0.5,
};

const CORROBORATION_BONUS = 0.2;

// In-memory cache: sourceId → base_trust_weight
// Populated by load(), falls back to DEFAULTS for unknown sources.
const _cache = new Map(Object.entries(DEFAULTS));

// ─── Sync weight lookup ───────────────────────────────────────────────────────

function getWeight(sourceId) {
  const id = String(sourceId || 'system').toLowerCase();
  return _cache.get(id) ?? 0.5;
}

// Applies corroboration bonus: capped at 1.0.
function computeEffective(sourceId, corroborated = false) {
  const base = getWeight(sourceId);
  return corroborated ? Math.min(1.0, base + CORROBORATION_BONUS) : base;
}

// ─── DB-backed cache load ─────────────────────────────────────────────────────
// Called once at startup after db.init() + broker.seedSources().

async function load() {
  try {
    const { rows } = await pool.query(
      'SELECT id, base_trust_weight FROM lb_sources'
    );
    for (const row of rows) {
      _cache.set(row.id.toLowerCase(), row.base_trust_weight);
    }
    console.log(`[trust] Loaded ${rows.length} source weights from DB.`);
  } catch (err) {
    console.warn('[trust] Could not load source weights from DB — using defaults:', err.message);
  }
}

// ─── Known source type weights ────────────────────────────────────────────────
// Used by left-brain.registerSource and broker.seedSources when creating sources.

const SOURCE_TYPES = {
  MIKE:                { base: 1.0,  label: 'Ground truth (operator)' },
  PERSONA_DIRECT:      { base: 0.7,  label: 'First-hand observation' },
  PERSONA_INFERENCE:   { base: 0.5,  label: 'Derived inference' },
  PERSONA_SPECULATION: { base: 0.3,  label: 'Exploratory speculation' },
};

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  getWeight,
  computeEffective,
  load,
  SOURCE_TYPES,
  DEFAULTS,
};
