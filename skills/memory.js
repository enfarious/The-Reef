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
    // relationship is only present on memories surfaced via graph traversal
    const linkNote = m.relationship ? ` ↔ ${m.relationship}` : '';
    const header  = `[${m.type.toUpperCase()} · ${m.left_by} · ${ts}${linkNote}]`;
    const title   = m.title   ? `${m.title}\n` : '';
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
  const { persona, limit = 10, tokenBudget = null } = args;
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
       ORDER BY posted_to_reef DESC, created_at DESC
       LIMIT $${idxOffset}`,
      archivalParams
    );
    archival = rows;
  }

  // Merge + sort by recency
  const all = [...own, ...archival].sort(
    (a, b) => new Date(b.created_at) - new Date(a.created_at)
  );

  // ── Graph traversal: 1 hop from any primary memory ─────────────────────────
  // Fetch memories linked to/from anything in `all`, ranked by strength.
  // Excluded: memories already in `all`.  Cap: 5 extra entries at strength ≥ 0.5.
  const allIds = all.map(m => m.id);
  let linked = [];

  if (allIds.length) {
    const THRESHOLD = 0.5;
    const LINKED_CAP = 5;

    // Two queries (forward + backward) then deduplicate in JS — cleaner than UNION
    const [{ rows: fwd }, { rows: bwd }] = await Promise.all([
      pool.query(
        `SELECT m.id, m.left_by, m.type, m.title, m.slug, m.subject, m.body,
                m.tags, m.created_at, m.posted_to_reef, m.reef_entry_id,
                ml.relationship, ml.strength
         FROM memory_links ml JOIN memories m ON m.id = ml.to_id
         WHERE ml.from_id = ANY($1::int[])
           AND ml.strength >= $2
           AND m.id != ALL($1::int[])
         ORDER BY ml.strength DESC LIMIT $3`,
        [allIds, THRESHOLD, LINKED_CAP]
      ),
      pool.query(
        `SELECT m.id, m.left_by, m.type, m.title, m.slug, m.subject, m.body,
                m.tags, m.created_at, m.posted_to_reef, m.reef_entry_id,
                ml.relationship, ml.strength
         FROM memory_links ml JOIN memories m ON m.id = ml.from_id
         WHERE ml.to_id = ANY($1::int[])
           AND ml.strength >= $2
           AND m.id != ALL($1::int[])
         ORDER BY ml.strength DESC LIMIT $3`,
        [allIds, THRESHOLD, LINKED_CAP]
      ),
    ]);

    // Keep the strongest link when the same memory appears in both directions
    const linkedMap = new Map();
    for (const r of [...fwd, ...bwd]) {
      const existing = linkedMap.get(r.id);
      if (!existing || r.strength > existing.strength) linkedMap.set(r.id, r);
    }
    linked = [...linkedMap.values()]
      .sort((a, b) => b.strength - a.strength)
      .slice(0, LINKED_CAP);
  }

  // Primary memories first (own + archival by recency), linked appended after
  const allWithLinked = [...all, ...linked];

  // ── Token budget trimming ────────────────────────────────────────────────
  // If a tokenBudget is provided (caller passes ~30 % of their context window),
  // include memories greedily in priority order until the budget is spent.
  // We always include at least one memory so a single oversized entry doesn't
  // silently leave the entity memory-less.
  // Estimate: (body + title + subject) chars / 4  +  80-char header overhead.
  let finalMemories = allWithLinked;
  if (tokenBudget != null && tokenBudget > 0) {
    const trimmed  = [];
    let   used     = 0;
    for (const m of allWithLinked) {
      const chars = (m.body    || '').length
                  + (m.title   || '').length
                  + (m.subject || '').length
                  + 80;                          // header + separators
      const est   = Math.ceil(chars / 4);
      if (trimmed.length > 0 && used + est > tokenBudget) break;
      trimmed.push(m);
      used += est;
    }
    finalMemories = trimmed;
  }

  return {
    memories:     finalMemories,
    contextBlock: formatMemoryBlock(finalMemories),
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

// ─── link ──────────────────────────────────────────────────────────────────────
// Create (or update) a directed association between two memories.
// Call this when you notice a meaningful connection between two memory IDs.
// Memory IDs are returned by memory_save and included in memory_search results.
//
// Relationship vocabulary (freeform, but these work well):
//   related · builds_on · contradicts · refines · inspired_by · continues · references
//
// args: { from_id, to_id, relationship?, strength?, created_by }

async function link(args) {
  const {
    from_id,
    to_id,
    relationship = 'related',
    strength     = 1.0,
    created_by,
  } = args;

  if (!from_id)    throw new Error('from_id is required');
  if (!to_id)      throw new Error('to_id is required');
  if (!created_by) throw new Error('created_by is required');
  if (Number(from_id) === Number(to_id)) throw new Error('Cannot link a memory to itself');

  const s = Math.max(0, Math.min(1, Number(strength) || 1.0));

  // Verify both memory IDs exist before attempting the link
  const { rows: existing } = await pool.query(
    `SELECT id FROM memories WHERE id IN ($1, $2)`,
    [Number(from_id), Number(to_id)]
  );
  const found = new Set(existing.map(r => r.id));
  if (!found.has(Number(from_id))) throw new Error(`Memory ${from_id} not found — cannot create link.`);
  if (!found.has(Number(to_id)))   throw new Error(`Memory ${to_id} not found — cannot create link.`);

  // Upsert: update relationship + strength if this directed link already exists
  const { rows } = await pool.query(
    `INSERT INTO memory_links (from_id, to_id, relationship, strength, created_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (from_id, to_id) DO UPDATE
       SET relationship = EXCLUDED.relationship,
           strength     = EXCLUDED.strength,
           created_by   = EXCLUDED.created_by
     RETURNING *`,
    [Number(from_id), Number(to_id), relationship.trim(), s, normalizePersona(created_by)]
  );
  return rows[0];
}

// ─── graph ─────────────────────────────────────────────────────────────────────
// Returns all memories + all memory_links for graph visualisation.
// No filtering — the visualiser handles that on the frontend.
// args: { limit }

async function graph(args) {
  const { limit = 400 } = args ?? {};

  const { rows: nodes } = await pool.query(
    `SELECT id, left_by, type, title, slug, subject, body, tags,
            created_at, posted_to_reef, reef_entry_id
     FROM memories
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit]
  );

  const ids = nodes.map(n => n.id);
  let links = [];

  if (ids.length) {
    const { rows } = await pool.query(
      `SELECT from_id, to_id, relationship, strength, created_by
       FROM memory_links
       WHERE from_id = ANY($1::int[]) OR to_id = ANY($1::int[])`,
      [ids]
    );
    links = rows;
  }

  return { nodes, links };
}

// ─── monitor ───────────────────────────────────────────────────────────────────
// Colony-wide memory ecology stats.
// args: {}

async function monitor(_args) {
  const [
    { rows: totals },
    { rows: byType },
    { rows: byPersona },
    { rows: linkTotals },
    { rows: recentActivity },
    { rows: topTags },
  ] = await Promise.all([
    pool.query(`SELECT
      COUNT(*)::int AS total_memories,
      COUNT(*) FILTER (WHERE posted_to_reef = true)::int AS posted_to_reef
    FROM memories`),
    pool.query(`SELECT type, COUNT(*)::int AS count
      FROM memories GROUP BY type ORDER BY count DESC`),
    pool.query(`SELECT left_by, COUNT(*)::int AS count
      FROM memories GROUP BY left_by ORDER BY count DESC`),
    pool.query(`SELECT
      COUNT(*)::int AS total_links,
      COUNT(*) FILTER (WHERE strength >= 0.7)::int AS strong_links
    FROM memory_links`),
    pool.query(`SELECT DATE(created_at) AS day, COUNT(*)::int AS count
      FROM memories
      WHERE created_at > NOW() - INTERVAL '30 days'
      GROUP BY day ORDER BY day DESC LIMIT 14`),
    pool.query(`SELECT unnest(tags) AS tag, COUNT(*)::int AS count
      FROM memories WHERE tags IS NOT NULL AND cardinality(tags) > 0
      GROUP BY tag ORDER BY count DESC LIMIT 20`),
  ]);

  return {
    total_memories:  totals[0].total_memories,
    posted_to_reef:  totals[0].posted_to_reef,
    by_type:         byType,
    by_persona:      byPersona,
    total_links:     linkTotals[0].total_links,
    strong_links:    linkTotals[0].strong_links,
    recent_activity: recentActivity,
    top_tags:        topTags,
  };
}

// ─── dedupe ────────────────────────────────────────────────────────────────────
// Find duplicate or near-duplicate memories and optionally delete the older copies.
//
// args: { dry_run?, threshold?, left_by? }
//   dry_run   — if true (default), report pairs without deleting anything
//   threshold — similarity cutoff 0.0–1.0 (default 0.85); uses pg_trgm if available,
//               falls back to exact body matching otherwise
//   left_by   — restrict search to pairs where at least one memory is from this persona

async function dedupe(args) {
  const {
    dry_run   = true,
    threshold = 0.85,
    left_by   = null,
  } = args;

  const persona = left_by ? normalizePersona(left_by) : null;

  // ── 1. Try trigram similarity (requires pg_trgm extension) ──────────────────
  let pairs = [];
  let method = 'exact';

  try {
    const params = [threshold];
    const personaFilter = persona ? ` AND (a.left_by = $2 OR b.left_by = $2)` : '';
    if (persona) params.push(persona);

    const { rows } = await pool.query(
      `SELECT
         a.id           AS id_a,    a.left_by AS left_by_a,
         a.title        AS title_a, a.created_at AS created_at_a,
         b.id           AS id_b,    b.left_by AS left_by_b,
         b.title        AS title_b, b.created_at AS created_at_b,
         similarity(a.body, b.body) AS sim
       FROM memories a
       JOIN memories b ON a.id < b.id
       WHERE similarity(a.body, b.body) >= $1
       ${personaFilter}
       ORDER BY sim DESC
       LIMIT 100`,
      params
    );
    pairs  = rows;
    method = 'trigram';
  } catch {
    // ── 2. Exact body match fallback (no pg_trgm needed) ──────────────────────
    const params = [];
    const personaFilter = persona
      ? ` AND (a.left_by = $${params.push(persona)} OR b.left_by = $${params.length})`
      : '';
    // push() returns new length so the same param index is reused for both sides

    // Fix: build param list properly
    const exactParams = persona ? [persona] : [];
    const exactFilter = persona
      ? ' AND (a.left_by = $1 OR b.left_by = $1)'
      : '';

    const { rows } = await pool.query(
      `SELECT
         a.id           AS id_a,    a.left_by AS left_by_a,
         a.title        AS title_a, a.created_at AS created_at_a,
         b.id           AS id_b,    b.left_by AS left_by_b,
         b.title        AS title_b, b.created_at AS created_at_b,
         1.0            AS sim
       FROM memories a
       JOIN memories b ON a.id < b.id AND a.body = b.body
       ${exactFilter.length ? 'WHERE' + exactFilter : ''}
       ORDER BY a.id
       LIMIT 100`,
      exactParams
    );
    pairs  = rows;
    method = 'exact';
  }

  if (!pairs.length) {
    return { message: 'No duplicates found.', deleted: 0, pairs: [], method };
  }

  const summary = pairs.map(p => ({
    keep:    { id: p.id_b, left_by: p.left_by_b, title: p.title_b || '(no title)', created_at: p.created_at_b },
    discard: { id: p.id_a, left_by: p.left_by_a, title: p.title_a || '(no title)', created_at: p.created_at_a },
    similarity: parseFloat(Number(p.sim).toFixed(3)),
  }));

  if (dry_run) {
    return {
      message: `Found ${pairs.length} duplicate pair(s). Re-run with dry_run: false to delete the older copies.`,
      deleted: 0,
      pairs:   summary,
      method,
    };
  }

  // Delete the older copy (lower id = older) from each pair
  const idsToDelete = pairs.map(p => p.id_a);
  await pool.query(
    `DELETE FROM memories WHERE id = ANY($1::int[])`,
    [idsToDelete]
  );

  return {
    message: `Deleted ${idsToDelete.length} duplicate(s). Kept the newer copy in each pair.`,
    deleted: idsToDelete.length,
    pairs:   summary,
    method,
  };
}

module.exports = { save, search, wakeup, list, update, link, graph, monitor, dedupe };
