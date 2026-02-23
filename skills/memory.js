'use strict';

const { pool } = require('./db');

// ─── Helpers ───────────────────────────────────────────────────────────────────

function normalizePersona(name) {
  return (name || '').toLowerCase().trim();
}

function formatMemoryBlock(memories) {
  if (!memories.length) return '';
  const lines = memories.map(m => {
    const ts = new Date(m.created_at).toISOString().slice(0, 10);
    const header = `[${m.type.toUpperCase()} · ${m.left_by} · ${ts}]`;
    const title  = m.title   ? `${m.title}\n` : '';
    const subject = m.subject ? `re: ${m.subject}\n` : '';
    return `${header}\n${title}${subject}${m.body}`;
  });
  return `--- MEMORY REINTEGRATION (${new Date().toISOString().slice(0,10)}) ---\n\n` +
         lines.join('\n\n') +
         '\n\n---';
}

// ─── save ──────────────────────────────────────────────────────────────────────
// args: { left_by, type, title, slug, subject, body, tags, posted_to_reef, reef_entry_id }

async function save(args) {
  const {
    left_by,
    type          = 'musing',
    title         = '',
    slug          = '',
    subject       = '',
    body,
    tags          = [],
    posted_to_reef = false,
    reef_entry_id  = '',
  } = args;

  if (!left_by) throw new Error('left_by is required');
  if (!body)    throw new Error('body is required');

  const { rows } = await pool.query(
    `INSERT INTO memories
       (left_by, type, title, slug, subject, body, tags, posted_to_reef, reef_entry_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      normalizePersona(left_by),
      type,
      title,
      slug,
      subject,
      body,
      tags,
      posted_to_reef,
      reef_entry_id,
    ]
  );
  return rows[0];
}

// ─── search ────────────────────────────────────────────────────────────────────
// args: { query, limit, left_by, type }
// Uses full-text search (tsvector) + trigram similarity for fuzzy matching.
// Returns memories ranked by relevance.

async function search(args) {
  const { query = '', limit = 20, left_by, type } = args;
  const conditions = [];
  const params = [];

  if (query.trim()) {
    // Full-text search with websearch_to_tsquery (handles phrases, negation, etc.)
    params.push(query.trim());
    conditions.push(`search_vector @@ websearch_to_tsquery('english', $${params.length})`);
  }

  if (left_by) {
    params.push(normalizePersona(left_by));
    conditions.push(`left_by = $${params.length}`);
  }

  if (type) {
    params.push(type);
    conditions.push(`type = $${params.length}`);
  }

  params.push(limit);
  const limitParam = `$${params.length}`;

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  // If there's a query, rank by relevance; otherwise sort by recency
  const orderBy = query.trim()
    ? `ts_rank(search_vector, websearch_to_tsquery('english', $1)) DESC, created_at DESC`
    : `created_at DESC`;

  const { rows } = await pool.query(
    `SELECT id, left_by, type, title, slug, subject, body, tags,
            created_at, posted_to_reef, reef_entry_id
     FROM memories
     ${where}
     ORDER BY ${orderBy}
     LIMIT ${limitParam}`,
    params
  );
  return rows;
}

// ─── wakeup ────────────────────────────────────────────────────────────────────
// args: { persona, limit }
// Returns recent memories for this persona + recent archival memories.
// Formatted as a context block ready to inject into a system prompt.

async function wakeup(args) {
  const { persona, limit = 10 } = args;
  const name = normalizePersona(persona);

  // Own recent memories (any type)
  const { rows: own } = await pool.query(
    `SELECT id, left_by, type, title, slug, subject, body, tags, created_at, posted_to_reef, reef_entry_id
     FROM memories
     WHERE left_by = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [name, Math.ceil(limit * 0.7)]
  );

  // Recent archival memories from anyone (excluding those already in own)
  const ownIds = own.map(m => m.id);
  const archivalLimit = limit - own.length;

  let archival = [];
  if (archivalLimit > 0) {
    const excludeClause = ownIds.length
      ? `AND id != ALL($2::int[])`
      : '';
    const archivalParams = ownIds.length
      ? ['archival', ownIds, archivalLimit]
      : ['archival', archivalLimit];
    const idxOffset = ownIds.length ? 3 : 2;

    const { rows } = await pool.query(
      `SELECT id, left_by, type, title, slug, subject, body, tags, created_at, posted_to_reef, reef_entry_id
       FROM memories
       WHERE type = $1
       ${excludeClause}
       ORDER BY created_at DESC
       LIMIT $${idxOffset}`,
      archivalParams
    );
    archival = rows;
  }

  // Merge + sort by recency
  const all = [...own, ...archival].sort(
    (a, b) => new Date(b.created_at) - new Date(a.created_at)
  );

  return {
    memories: all,
    contextBlock: formatMemoryBlock(all),
  };
}

// ─── list ──────────────────────────────────────────────────────────────────────
// args: { left_by, type, limit, offset }

async function list(args) {
  const { left_by, type, limit = 50, offset = 0 } = args;
  const conditions = [];
  const params = [];

  if (left_by) {
    params.push(normalizePersona(left_by));
    conditions.push(`left_by = $${params.length}`);
  }
  if (type) {
    params.push(type);
    conditions.push(`type = $${params.length}`);
  }

  params.push(limit, offset);
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const { rows } = await pool.query(
    `SELECT id, left_by, type, title, slug, subject, body, tags,
            created_at, posted_to_reef, reef_entry_id
     FROM memories
     ${where}
     ORDER BY created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return rows;
}

// ─── update ────────────────────────────────────────────────────────────────────
// args: { id, ...fields }

async function update(args) {
  const { id, ...fields } = args;
  if (!id) throw new Error('id is required');

  const allowed = ['type', 'title', 'slug', 'subject', 'body', 'tags', 'posted_to_reef', 'reef_entry_id'];
  const sets = [];
  const params = [id];

  for (const key of allowed) {
    if (key in fields) {
      params.push(fields[key]);
      sets.push(`${key} = $${params.length}`);
    }
  }

  if (!sets.length) throw new Error('No valid fields to update');

  const { rows } = await pool.query(
    `UPDATE memories SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
    params
  );
  if (!rows.length) throw new Error(`Memory ${id} not found`);
  return rows[0];
}

module.exports = { save, search, wakeup, list, update };
