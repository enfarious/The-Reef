'use strict';

// ─── Cold Storage — Pruned Edge Archive ───────────────────────────────────────
//
// Edges that fall below the right-brain prune threshold are moved here rather
// than deleted.  Nothing is permanently lost — retrieval cost just increases.
//
// Storage: PostgreSQL graph_archive table (schema created in db.js SQL_GRAPH_ARCHIVE).
// Standard recall does NOT include archived edges. They must be explicitly requested
// via retrieve() and always carry a retrieval_cost: 'high' marker.

const { pool } = require('./db');

// ─── archive ─────────────────────────────────────────────────────────────────
// Bulk-insert pruned edges from the right-brain decay pass.
// prunedEdges: [{ fromId, toId, relation, weight, salience, createdAt }]
// Returns: number of edges archived.

async function archive(prunedEdges) {
  if (!prunedEdges || !prunedEdges.length) return 0;

  // Build a bulk INSERT using unnested arrays
  const values = prunedEdges.map((e, i) => {
    const base = i * 6;
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`;
  }).join(', ');

  const params = prunedEdges.flatMap(e => [
    e.fromId,
    e.toId,
    e.relation,
    e.weight,
    e.salience,
    e.createdAt ?? null,
  ]);

  await pool.query(
    `INSERT INTO graph_archive (from_id, to_id, relation, final_weight, salience, created_at_unix)
     VALUES ${values}`,
    params
  );

  return prunedEdges.length;
}

// ─── retrieve ─────────────────────────────────────────────────────────────────
// Deep-history recall of archived edges.  Not included in standard context assembly.
// args: { fromId?, toId?, relation?, limit? }
// Returns edges with retrieval_cost: 'high' flag attached.

async function retrieve({ fromId, toId, relation, limit = 50 } = {}) {
  const conditions = [];
  const params     = [];

  if (fromId) {
    params.push(fromId);
    conditions.push(`from_id = $${params.length}`);
  }
  if (toId) {
    params.push(toId);
    conditions.push(`to_id = $${params.length}`);
  }
  if (relation) {
    params.push(relation);
    conditions.push(`relation = $${params.length}`);
  }

  params.push(limit);
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const { rows } = await pool.query(
    `SELECT id, from_id, to_id, relation, final_weight, salience, pruned_at
     FROM graph_archive
     ${where}
     ORDER BY pruned_at DESC
     LIMIT $${params.length}`,
    params
  );

  return rows.map(r => ({ ...r, retrieval_cost: 'high' }));
}

// ─── stats ───────────────────────────────────────────────────────────────────

async function stats() {
  const { rows } = await pool.query(`
    SELECT COUNT(*)           AS total,
           MIN(pruned_at)     AS oldest_prune,
           MAX(pruned_at)     AS latest_prune,
           AVG(final_weight)  AS avg_final_weight
    FROM graph_archive
  `);
  return rows[0];
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = { archive, retrieve, stats };
