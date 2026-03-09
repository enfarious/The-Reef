'use strict';

// ─── Working Memory — Per-Persona Short-Term Buffer ────────────────────────────
//
// Fast-write, TTL-based staging buffer in SQLite (same DB as the right-brain graph).
// Items must earn consolidation eligibility (2+ appearances or 1 high-salience) before
// reaching long-term storage.  Items that expire without hitting the threshold fade
// silently — noise stays local.
//
// Schema lives in right-brain.js init() (working_memory table).
// Uses right-brain.getDb() for the SQLite handle.

const { randomUUID } = require('crypto');
const rightBrain = require('./right-brain');

const WORKING_MEMORY_TTL_SEC  = 15 * 60;   // 15 minutes
const MAX_ITEMS_PER_PERSONA   = 50;

function db() { return rightBrain.getDb(); }

// ─── write ────────────────────────────────────────────────────────────────────
// Adds a new item to working memory, or reinforces an existing exact match.
// Also creates a right-brain graph node for the item so consolidation can embed it.
// args: { personaId, content, salience?, highSalience? }

async function write({ personaId, content, salience = 0.5, highSalience = false } = {}) {
  if (!personaId) throw new Error('working_memory.write: personaId is required');
  if (!content)   throw new Error('working_memory.write: content is required');

  const d = db();

  // Check exact-match duplicate — reinforce if found
  const existing = d.prepare(`
    SELECT id FROM working_memory
    WHERE persona_id = ? AND content = ? AND consolidated = 0 AND expires_at > unixepoch()
  `).get(personaId, content);

  if (existing) {
    return reinforce({ id: existing.id });
  }

  // Evict oldest non-high-salience item if at cap
  const { cnt } = d.prepare(`
    SELECT COUNT(*) as cnt FROM working_memory
    WHERE persona_id = ? AND consolidated = 0 AND expires_at > unixepoch()
  `).get(personaId);

  if (cnt >= MAX_ITEMS_PER_PERSONA) {
    d.prepare(`
      DELETE FROM working_memory
      WHERE id = (
        SELECT id FROM working_memory
        WHERE persona_id = ? AND consolidated = 0 AND high_sal = 0
        ORDER BY created_at ASC
        LIMIT 1
      )
    `).run(personaId);
  }

  const id        = randomUUID();
  const expiresAt = Math.floor(Date.now() / 1000) + WORKING_MEMORY_TTL_SEC;

  d.prepare(`
    INSERT INTO working_memory (id, persona_id, content, salience, high_sal, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, personaId, content, salience, highSalience ? 1 : 0, expiresAt);

  // Register as a right-brain node so consolidation can embed + cluster it.
  // Fire-and-forget — non-fatal if right-brain isn't ready yet.
  rightBrain.ensureNode({ id, label: content.slice(0, 60), text: content }).catch(() => {});

  return { id, personaId, content, salience, expiresAt };
}

// ─── reinforce ────────────────────────────────────────────────────────────────
// Increments appearances count and refreshes the TTL.
// args: { id }

function reinforce({ id } = {}) {
  const d = db();
  const expiresAt = Math.floor(Date.now() / 1000) + WORKING_MEMORY_TTL_SEC;
  d.prepare(`
    UPDATE working_memory
    SET appearances = appearances + 1, expires_at = ?
    WHERE id = ?
  `).run(expiresAt, id);
  return d.prepare('SELECT * FROM working_memory WHERE id = ?').get(id);
}

// ─── read ─────────────────────────────────────────────────────────────────────
// Returns all active (non-expired, non-consolidated) items for a persona.
// Also returns items written with persona_id = 'all' (dream fragments for everyone).
// args: { personaId, includeAll? }

function read({ personaId, includeAll = true } = {}) {
  if (!personaId) throw new Error('working_memory.read: personaId is required');
  const d = db();
  const now = Math.floor(Date.now() / 1000);

  if (includeAll) {
    return d.prepare(`
      SELECT * FROM working_memory
      WHERE (persona_id = ? OR persona_id = 'all')
        AND consolidated = 0
        AND expires_at > ?
      ORDER BY salience DESC, created_at DESC
    `).all(personaId, now);
  }

  return d.prepare(`
    SELECT * FROM working_memory
    WHERE persona_id = ? AND consolidated = 0 AND expires_at > ?
    ORDER BY salience DESC, created_at DESC
  `).all(personaId, now);
}

// ─── pendingConsolidation ─────────────────────────────────────────────────────
// Items that have earned consolidation eligibility: 2+ appearances OR high-salience.
// args: { personaId }

function pendingConsolidation({ personaId } = {}) {
  return db().prepare(`
    SELECT * FROM working_memory
    WHERE persona_id = ? AND consolidated = 0
      AND (appearances >= 2 OR high_sal = 1)
      AND expires_at > unixepoch()
    ORDER BY salience DESC, created_at DESC
  `).all(personaId);
}

// ─── markConsolidated ────────────────────────────────────────────────────────
// args: { id }

function markConsolidated({ id } = {}) {
  db().prepare('UPDATE working_memory SET consolidated = 1 WHERE id = ?').run(id);
}

// ─── sweep ───────────────────────────────────────────────────────────────────
// Removes expired and already-consolidated items.  Called by the decay scheduler.

function sweep() {
  const now = Math.floor(Date.now() / 1000);
  const { changes } = db().prepare(`
    DELETE FROM working_memory
    WHERE expires_at <= ? OR consolidated = 1
  `).run(now);
  return { expired: changes };
}

// ─── stats ───────────────────────────────────────────────────────────────────

function stats() {
  const rows = db().prepare(`
    SELECT persona_id,
           COUNT(*) as total,
           SUM(CASE WHEN consolidated = 0 AND expires_at > unixepoch() THEN 1 ELSE 0 END) as active,
           SUM(CASE WHEN consolidated = 1 THEN 1 ELSE 0 END) as consolidated_count
    FROM working_memory
    GROUP BY persona_id
  `).all();
  return rows;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  write,
  reinforce,
  read,
  pendingConsolidation,
  markConsolidated,
  sweep,
  stats,
};
