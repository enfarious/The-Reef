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

// ─── Schema init ───────────────────────────────────────────────────────────────

const INIT_SQL = `
  -- Enable trigram extension for fuzzy search (requires pg_trgm, which ships
  -- with standard PostgreSQL — run as superuser if this fails).
  CREATE EXTENSION IF NOT EXISTS pg_trgm;

  -- Memories table — collective pool, shared across all personas.
  CREATE TABLE IF NOT EXISTS memories (
    id              SERIAL PRIMARY KEY,
    left_by         TEXT        NOT NULL,                  -- persona name (lowercase)
    type            TEXT        NOT NULL DEFAULT 'musing', -- personal | archival | work | musing | observation
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

  -- GIN indexes for fast search
  CREATE INDEX IF NOT EXISTS idx_memories_fts     ON memories USING GIN(search_vector);
  CREATE INDEX IF NOT EXISTS idx_memories_trgm_title   ON memories USING GIN(title   gin_trgm_ops);
  CREATE INDEX IF NOT EXISTS idx_memories_trgm_subject ON memories USING GIN(subject gin_trgm_ops);
  CREATE INDEX IF NOT EXISTS idx_memories_trgm_body    ON memories USING GIN(body    gin_trgm_ops);
  CREATE INDEX IF NOT EXISTS idx_memories_left_by ON memories (left_by);
  CREATE INDEX IF NOT EXISTS idx_memories_type    ON memories (type);
  CREATE INDEX IF NOT EXISTS idx_memories_created ON memories (created_at DESC);

  -- Auto-update tsvector on insert/update
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

async function init() {
  const client = await pool.connect();
  try {
    await client.query(INIT_SQL);
    console.log('[db] Schema ready.');
  } catch (err) {
    console.error('[db] Schema init failed:', err.message);
    // pg_trgm might need superuser — retry without trigram indexes if it failed
    if (err.message.includes('pg_trgm') || err.message.includes('permission')) {
      console.warn('[db] pg_trgm unavailable — falling back to full-text search only.');
      await client.query(INIT_SQL.replace(/CREATE EXTENSION IF NOT EXISTS pg_trgm;/, '')
                                 .replace(/CREATE INDEX IF NOT EXISTS idx_memories_trgm[\s\S]*?;\n/g, ''));
    } else {
      throw err;
    }
  } finally {
    client.release();
  }
}

module.exports = { pool, init };
