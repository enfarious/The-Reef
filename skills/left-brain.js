'use strict';

// ─── Left Brain — Deterministic Factual Store ──────────────────────────────────
//
// PostgreSQL-backed entity/attribute/episode store.  Facts are revised, not
// forgotten: setFact marks the old row stale before inserting the new one.
// Contradictions are flagged for broker arbitration rather than silently overwritten.
//
// Tables: lb_entities, lb_attributes, lb_episodes, lb_sources, lb_contradictions
// (schema created in db.js SQL_LEFT_BRAIN block)

const { pool } = require('./db');

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Default trust weights by source type — Phase 4 trust.js will own this, but
// we need sensible values before that module exists.
const DEFAULT_TRUST = {
  mike:    1.0,
  dreamer: 0.7,
  builder: 0.7,
  librarian: 0.7,
};

function trustFor(sourceId) {
  return DEFAULT_TRUST[String(sourceId).toLowerCase()] ?? 0.5;
}

// ─── Sources ──────────────────────────────────────────────────────────────────

// Upsert a source record.  Called at startup by broker to seed the three personas.
async function registerSource(id, name, instanceType = 'persona', baseTrustWeight = null) {
  const trust = baseTrustWeight ?? trustFor(id);
  await pool.query(
    `INSERT INTO lb_sources (id, name, instance_type, base_trust_weight)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE
       SET name = EXCLUDED.name,
           base_trust_weight = EXCLUDED.base_trust_weight`,
    [id, name, instanceType, trust]
  );
}

// ─── Entities ─────────────────────────────────────────────────────────────────

// Upsert an entity, refreshing last_seen on conflict.
async function upsertEntity(name, type = 'entity') {
  const { rows } = await pool.query(
    `INSERT INTO lb_entities (name, type)
     VALUES ($1, $2)
     ON CONFLICT (name) DO UPDATE
       SET last_seen = NOW(), type = EXCLUDED.type
     RETURNING *`,
    [name, type]
  );
  return rows[0];
}

// ─── Attributes (facts) ───────────────────────────────────────────────────────

// Write a fact. Marks any existing non-stale attribute for (entity, key) as stale
// before inserting the new one. Implements "revise, don't forget".
async function setFact(entityName, key, value, sourceId = 'system', trustWeight = null) {
  const trust = trustWeight ?? trustFor(sourceId);
  const entity = await upsertEntity(entityName);

  // Mark existing current fact stale
  await pool.query(
    `UPDATE lb_attributes
     SET is_stale = TRUE, valid_to = NOW()
     WHERE entity_id = $1 AND key = $2 AND is_stale = FALSE`,
    [entity.id, key]
  );

  const { rows } = await pool.query(
    `INSERT INTO lb_attributes (entity_id, key, value, source_id, trust_weight)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [entity.id, key, value, sourceId, trust]
  );
  return rows[0];
}

// Get all current (non-stale) facts for an entity, freshest first.
async function getFacts(entityName) {
  const { rows } = await pool.query(
    `SELECT a.id, a.key, a.value, a.source_id, a.trust_weight, a.valid_from, a.is_stale
     FROM lb_attributes a
     JOIN lb_entities e ON e.id = a.entity_id
     WHERE e.name = $1 AND a.is_stale = FALSE
     ORDER BY a.valid_from DESC`,
    [entityName]
  );
  return rows;
}

// ─── Episodes ─────────────────────────────────────────────────────────────────

async function recordEpisode(content, entityNames = [], sourceId = 'system', salience = 0.5) {
  const { rows } = await pool.query(
    `INSERT INTO lb_episodes (content, entities_involved, source_id, salience)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [content, entityNames, sourceId, salience]
  );
  return rows[0];
}

// Fetch recent high-salience episodes — used by broker to seed traversal anchors.
async function getRecentHighSalience(limit = 5) {
  const { rows } = await pool.query(
    `SELECT id, content, entities_involved, source_id, salience, created_at
     FROM lb_episodes
     ORDER BY salience DESC, created_at DESC
     LIMIT $1`,
    [limit]
  );
  return rows;
}

// ─── Contradiction handling ───────────────────────────────────────────────────

// Check if newValue for (entityName, key) contradicts the current stored value.
// Returns { contradicts: bool, existing: attributeRow | null }.
async function checkContradiction(entityName, key, newValue) {
  const { rows } = await pool.query(
    `SELECT a.id, a.value, a.source_id, a.trust_weight
     FROM lb_attributes a
     JOIN lb_entities e ON e.id = a.entity_id
     WHERE e.name = $1 AND a.key = $2 AND a.is_stale = FALSE
     LIMIT 1`,
    [entityName, key]
  );
  if (!rows.length) return { contradicts: false, existing: null };
  const existing = rows[0];
  const contradicts = existing.value.trim().toLowerCase() !== newValue.trim().toLowerCase();
  return { contradicts, existing };
}

async function flagContradiction(attributeId, newValue, sourceId) {
  const { rows } = await pool.query(
    `INSERT INTO lb_contradictions (attribute_id, new_value, source_id)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [attributeId, newValue, sourceId]
  );
  return rows[0];
}

async function listPendingContradictions() {
  const { rows } = await pool.query(
    `SELECT c.id, c.new_value, c.source_id, c.flagged_at,
            a.key, a.value AS existing_value, a.trust_weight,
            e.name AS entity_name
     FROM lb_contradictions c
     JOIN lb_attributes a ON a.id = c.attribute_id
     JOIN lb_entities e ON e.id = a.entity_id
     WHERE c.resolved = FALSE
     ORDER BY c.flagged_at DESC`
  );
  return rows;
}

async function resolveContradiction(contradictionId) {
  await pool.query(
    `UPDATE lb_contradictions SET resolved = TRUE WHERE id = $1`,
    [contradictionId]
  );
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  registerSource,
  upsertEntity,
  setFact,
  getFacts,
  recordEpisode,
  getRecentHighSalience,
  checkContradiction,
  flagContradiction,
  listPendingContradictions,
  resolveContradiction,
  trustFor,
};
