'use strict';

const { pool } = require('./db');
const { randomUUID } = require('crypto');

// ─── createDream ────────────────────────────────────────────────────────────────
async function createDream() {
  return { dreamId: randomUUID() };
}

// ─── writeStage ─────────────────────────────────────────────────────────────────
async function writeStage({ dreamId, coil, stage, personaId, input, output }) {
  if (!dreamId) throw new Error('dreamId is required');
  if (!coil || !stage) throw new Error('coil and stage are required');

  const { rows } = await pool.query(
    `INSERT INTO dream_stages (dream_id, coil, stage, persona_id, input, output)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, dream_id, coil, stage, created_at`,
    [dreamId, coil, stage, personaId || stage, input || null, output || null]
  );
  return rows[0];
}

// ─── latestCompletedOutput ──────────────────────────────────────────────────────
// Get C's coil-2 output from most recent completed dream (seeds next dream's A)
async function latestCompletedOutput() {
  const { rows } = await pool.query(
    `SELECT output FROM dream_stages
     WHERE coil = 2 AND stage = 'C'
     ORDER BY created_at DESC
     LIMIT 1`
  );
  return rows[0]?.output || null;
}

// ─── previousCoilOutput ─────────────────────────────────────────────────────────
// Get C's coil-1 output for current dream (seeds coil-2's A)
async function previousCoilOutput({ dreamId }) {
  if (!dreamId) throw new Error('dreamId is required');
  const { rows } = await pool.query(
    `SELECT output FROM dream_stages
     WHERE dream_id = $1 AND coil = 1 AND stage = 'C'
     LIMIT 1`,
    [dreamId]
  );
  return rows[0]?.output || null;
}

// ─── listDreams ─────────────────────────────────────────────────────────────────
async function listDreams({ limit, offset } = {}) {
  const { rows } = await pool.query(
    `SELECT dream_id,
            MIN(created_at) AS started_at,
            MAX(created_at) AS last_touch,
            COUNT(*) AS touch_count,
            MAX(coil) AS max_coil,
            BOOL_OR(coil = 2 AND stage = 'C') AS complete
     FROM dream_stages
     GROUP BY dream_id
     ORDER BY MIN(created_at) DESC
     LIMIT $1 OFFSET $2`,
    [limit || 20, offset || 0]
  );
  return rows;
}

// ─── dreamDetail ────────────────────────────────────────────────────────────────
async function dreamDetail({ dreamId }) {
  if (!dreamId) throw new Error('dreamId is required');
  const { rows } = await pool.query(
    `SELECT * FROM dream_stages
     WHERE dream_id = $1
     ORDER BY coil ASC,
              CASE stage WHEN 'A' THEN 1 WHEN 'B' THEN 2 WHEN 'C' THEN 3 END`,
    [dreamId]
  );
  return rows;
}

module.exports = { createDream, writeStage, latestCompletedOutput, previousCoilOutput, listDreams, dreamDetail };
