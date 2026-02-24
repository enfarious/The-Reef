'use strict';

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

// ─── Connection config ─────────────────────────────────────────────────────────
// Reads from db.config.json in project root (copy from db.config.example.json).
// Falls back to environment variables, then localhost defaults.

function loadDbConfig() {
  const cfgPath = path.join(__dirname, '..', 'db.config.json');
  if (fs.existsSync(cfgPath)) {
    try {
      const raw = fs.readFileSync(cfgPath, 'utf8');
      return JSON.parse(raw);
    } catch (e) {
      console.error('[db] Failed to parse db.config.json:', e.message);
    }
  }
  return {
    host:     process.env.DB_HOST     || 'localhost',
    port:     parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME     || 'reef',
    user:     process.env.DB_USER     || 'postgres',
    password: process.env.DB_PASSWORD || '',
  };
}

const pool = new Pool(loadDbConfig());

pool.on('error', (err) => {
  console.error('[db] Unexpected pool error:', err.message);
});

// ─── Schema sections ───────────────────────────────────────────────────────────
// Split into independent statements so a failure in one section never prevents
// the others from running.  Each is idempotent (IF NOT EXISTS / OR REPLACE).

// ── 1. pg_trgm extension (needs superuser on some setups — handled separately) ─
const SQL_TRGM = `CREATE EXTENSION IF NOT EXISTS pg_trgm;`;

// ── 2. Memories table + indexes + FTS trigger ──────────────────────────────────
const SQL_MEMORIES = `
  CREATE TABLE IF NOT EXISTS memories (
    id              SERIAL PRIMARY KEY,
    left_by         TEXT        NOT NULL,
    type            TEXT        NOT NULL DEFAULT 'musing',
    title           TEXT        NOT NULL DEFAULT '',
    slug            TEXT        NOT NULL DEFAULT '',
    subject         TEXT        NOT NULL DEFAULT '',
    body            TEXT        NOT NULL,
    tags            TEXT[]      NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    posted_to_reef  BOOLEAN     NOT NULL DEFAULT FALSE,
    reef_entry_id   TEXT        NOT NULL DEFAULT '',
    search_vector   TSVECTOR
  );

  CREATE INDEX IF NOT EXISTS idx_memories_fts     ON memories USING GIN(search_vector);
  CREATE INDEX IF NOT EXISTS idx_memories_left_by ON memories (left_by);
  CREATE INDEX IF NOT EXISTS idx_memories_type    ON memories (type);
  CREATE INDEX IF NOT EXISTS idx_memories_created ON memories (created_at DESC);

  CREATE OR REPLACE FUNCTION memories_update_tsvector() RETURNS TRIGGER AS $$
  BEGIN
    NEW.search_vector :=
      setweight(to_tsvector('english', COALESCE(NEW.title,   '')), 'A') ||
      setweight(to_tsvector('english', COALESCE(NEW.subject, '')), 'B') ||
      setweight(to_tsvector('english', COALESCE(NEW.body,    '')), 'C') ||
      setweight(to_tsvector('english', COALESCE(NEW.slug,    '')), 'D');
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;

  DROP TRIGGER IF EXISTS memories_tsvector_trigger ON memories;
  CREATE TRIGGER memories_tsvector_trigger
    BEFORE INSERT OR UPDATE ON memories
    FOR EACH ROW EXECUTE FUNCTION memories_update_tsvector();
`;

// ── 2b. Trigram indexes for memories (requires pg_trgm — added separately) ─────
const SQL_MEMORIES_TRGM = `
  CREATE INDEX IF NOT EXISTS idx_memories_trgm_title   ON memories USING GIN(title   gin_trgm_ops);
  CREATE INDEX IF NOT EXISTS idx_memories_trgm_subject ON memories USING GIN(subject gin_trgm_ops);
  CREATE INDEX IF NOT EXISTS idx_memories_trgm_body    ON memories USING GIN(body    gin_trgm_ops);
`;

// ── 3. Colony messaging table + indexes + FTS trigger ─────────────────────────
// Persistent async DMs between colony members.  Identified by persona name
// (lowercase) exactly like memories — no separate users table needed.
// Threading: reply_to_id → parent message.  Inbox = unread WHERE to_persona.
const SQL_MESSAGES = `
  CREATE TABLE IF NOT EXISTS messages (
    id            SERIAL      PRIMARY KEY,
    from_persona  TEXT        NOT NULL,
    to_persona    TEXT        NOT NULL,
    subject       TEXT        NOT NULL DEFAULT '',
    body          TEXT        NOT NULL,
    reply_to_id   INTEGER     REFERENCES messages(id) ON DELETE SET NULL,
    is_read       BOOLEAN     NOT NULL DEFAULT FALSE,
    read_at       TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    search_vector TSVECTOR
  );

  CREATE INDEX IF NOT EXISTS idx_messages_inbox   ON messages (to_persona, is_read) WHERE is_read = FALSE;
  CREATE INDEX IF NOT EXISTS idx_messages_from    ON messages (from_persona);
  CREATE INDEX IF NOT EXISTS idx_messages_thread  ON messages (reply_to_id);
  CREATE INDEX IF NOT EXISTS idx_messages_created ON messages (created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_messages_fts     ON messages USING GIN(search_vector);

  CREATE OR REPLACE FUNCTION messages_update_tsvector() RETURNS TRIGGER AS $$
  BEGIN
    NEW.search_vector :=
      setweight(to_tsvector('english', COALESCE(NEW.subject, '')), 'A') ||
      setweight(to_tsvector('english', COALESCE(NEW.body,    '')), 'B');
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;

  DROP TRIGGER IF EXISTS messages_tsvector_trigger ON messages;
  CREATE TRIGGER messages_tsvector_trigger
    BEFORE INSERT OR UPDATE ON messages
    FOR EACH ROW EXECUTE FUNCTION messages_update_tsvector();
`;

// ── 4. Memory linking table + indexes ─────────────────────────────────────────
// Directed associations between memory nodes.  Wakeup traverses 1 hop so linked
// memories surface alongside own memories during reintegration.
// UNIQUE(from_id, to_id) enables upsert semantics — calling memory_link again
// updates the relationship + strength rather than duplicating.
const SQL_MEMORY_LINKS = `
  CREATE TABLE IF NOT EXISTS memory_links (
    id           SERIAL      PRIMARY KEY,
    from_id      INTEGER     NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    to_id        INTEGER     NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    relationship TEXT        NOT NULL DEFAULT 'related',
    strength     FLOAT       NOT NULL DEFAULT 1.0 CHECK (strength >= 0 AND strength <= 1),
    created_by   TEXT        NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(from_id, to_id)
  );

  CREATE INDEX IF NOT EXISTS idx_memory_links_from     ON memory_links(from_id);
  CREATE INDEX IF NOT EXISTS idx_memory_links_to       ON memory_links(to_id);
  CREATE INDEX IF NOT EXISTS idx_memory_links_strength ON memory_links(strength DESC);
`;

// ─── Schema init ───────────────────────────────────────────────────────────────
// Each section runs as an independent query so a failure in one never blocks
// the others.  All statements are idempotent (IF NOT EXISTS / OR REPLACE).

async function runSection(client, label, sql) {
  try {
    await client.query(sql);
    console.log(`[db] ✓ ${label}`);
  } catch (err) {
    console.error(`[db] ✗ ${label}: ${err.message}`);
    throw err;
  }
}

async function init() {
  const client = await pool.connect();
  try {
    // 1. pg_trgm extension — may need superuser; non-fatal if unavailable
    let hasTrgm = true;
    try {
      await client.query(SQL_TRGM);
      console.log('[db] ✓ pg_trgm extension');
    } catch (err) {
      hasTrgm = false;
      console.warn('[db] pg_trgm unavailable — trigram indexes skipped (full-text search still works).');
    }

    // 2. Memories table (core — required)
    await runSection(client, 'memories table', SQL_MEMORIES);

    // 2b. Trigram indexes — only if pg_trgm loaded
    if (hasTrgm) {
      await runSection(client, 'memories trigram indexes', SQL_MEMORIES_TRGM);
    }

    // 3. Colony messaging (independent of memories)
    await runSection(client, 'messages table', SQL_MESSAGES);

    // 4. Memory linking (depends on memories table existing — runs after)
    await runSection(client, 'memory_links table', SQL_MEMORY_LINKS);

    console.log('[db] Schema ready.');
  } finally {
    client.release();
  }
}

module.exports = { pool, init };
