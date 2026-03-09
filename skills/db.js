'use strict';

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

// ─── Connection config ─────────────────────────────────────────────────────────
// Priority: userData reef-config.json database section → db.config.json → env → defaults.
// loadDbConfig() is called inside init() so app.getPath('userData') is always available.

function loadDbConfig() {
  // 1. userData/reef-config.json — user-configured DB settings (works in packaged app)
  try {
    const { app, safeStorage } = require('electron');
    const userCfgPath = path.join(app.getPath('userData'), 'reef-config.json');
    if (fs.existsSync(userCfgPath)) {
      const raw = JSON.parse(fs.readFileSync(userCfgPath, 'utf8'));
      if (raw.database && raw.database.host) {
        const db = { ...raw.database };
        // Decrypt password if it was encrypted by safeStorage
        if (typeof db.password === 'string' && db.password.startsWith('enc:')) {
          try {
            if (safeStorage.isEncryptionAvailable()) {
              db.password = safeStorage.decryptString(Buffer.from(db.password.slice(4), 'base64'));
            }
          } catch { /* keep as-is */ }
        }
        console.log('[db] Using database config from userData');
        return db;
      }
    }
  } catch { /* app not ready or parse error — fall through */ }

  // 2. Dev fallback: db.config.json next to main.js (excluded from packaged builds)
  const devCfgPath = path.join(__dirname, '..', 'db.config.json');
  if (fs.existsSync(devCfgPath)) {
    try {
      console.log('[db] Using db.config.json');
      return JSON.parse(fs.readFileSync(devCfgPath, 'utf8'));
    } catch (e) {
      console.error('[db] Failed to parse db.config.json:', e.message);
    }
  }

  // 3. Environment variables / defaults
  return {
    host:     process.env.DB_HOST     || 'localhost',
    port:     parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME     || 'reef',
    user:     process.env.DB_USER     || 'postgres',
    password: process.env.DB_PASSWORD || '',
  };
}

// ─── Pool proxy ────────────────────────────────────────────────────────────────
// Stable module-level export — safe to import before app.ready.
// The real pg.Pool is created inside init() once app.getPath('userData') is available.

let _pool = null;

const pool = new Proxy({}, {
  get(_, prop) {
    if (!_pool) throw new Error('[db] Pool not initialized — call db.init() first');
    const v = _pool[prop];
    return typeof v === 'function' ? v.bind(_pool) : v;
  },
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

// ── 5. Left-brain entity/attribute/episode tables ─────────────────────────────
// Deterministic factual store for the v3 distributed memory system.
// Revise-not-forget: setFact marks old rows stale before inserting new ones.
const SQL_LEFT_BRAIN = `
  CREATE TABLE IF NOT EXISTS lb_sources (
    id                TEXT PRIMARY KEY,
    name              TEXT NOT NULL,
    instance_type     TEXT NOT NULL DEFAULT 'persona',
    base_trust_weight FLOAT NOT NULL DEFAULT 0.7,
    salience_profile  JSONB
  );

  CREATE TABLE IF NOT EXISTS lb_entities (
    id         SERIAL PRIMARY KEY,
    name       TEXT NOT NULL UNIQUE,
    type       TEXT NOT NULL DEFAULT 'entity',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS lb_attributes (
    id           SERIAL PRIMARY KEY,
    entity_id    INTEGER NOT NULL REFERENCES lb_entities(id) ON DELETE CASCADE,
    key          TEXT NOT NULL,
    value        TEXT NOT NULL,
    source_id    TEXT NOT NULL DEFAULT 'system',
    trust_weight FLOAT NOT NULL DEFAULT 0.7,
    valid_from   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    valid_to     TIMESTAMPTZ,
    is_stale     BOOLEAN NOT NULL DEFAULT FALSE
  );
  CREATE INDEX IF NOT EXISTS idx_lb_attr_entity ON lb_attributes(entity_id, key, is_stale);

  CREATE TABLE IF NOT EXISTS lb_episodes (
    id                SERIAL PRIMARY KEY,
    content           TEXT NOT NULL,
    entities_involved TEXT[] NOT NULL DEFAULT '{}',
    source_id         TEXT NOT NULL DEFAULT 'system',
    salience          FLOAT NOT NULL DEFAULT 0.5,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_lb_episodes_salience ON lb_episodes(salience DESC, created_at DESC);

  CREATE TABLE IF NOT EXISTS lb_contradictions (
    id           SERIAL PRIMARY KEY,
    attribute_id INTEGER REFERENCES lb_attributes(id) ON DELETE CASCADE,
    new_value    TEXT NOT NULL,
    source_id    TEXT NOT NULL,
    flagged_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved     BOOLEAN NOT NULL DEFAULT FALSE
  );
`;

// ── 6. Graph archive (cold storage for pruned right-brain edges) ───────────────
const SQL_GRAPH_ARCHIVE = `
  CREATE TABLE IF NOT EXISTS graph_archive (
    id              SERIAL PRIMARY KEY,
    from_id         TEXT NOT NULL,
    to_id           TEXT NOT NULL,
    relation        TEXT NOT NULL,
    final_weight    REAL NOT NULL,
    salience        REAL NOT NULL,
    source_id       TEXT,
    created_at_unix INTEGER,
    pruned_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_archive_from ON graph_archive(from_id);
  CREATE INDEX IF NOT EXISTS idx_archive_to   ON graph_archive(to_id);
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
  _pool = new Pool(loadDbConfig());
  _pool.on('error', (err) => {
    console.error('[db] Unexpected pool error:', err.message);
  });

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

    // 5. Left-brain tables (v3 — independent, non-fatal)
    try {
      await client.query(SQL_LEFT_BRAIN);
      console.log('[db] ✓ left-brain tables');
    } catch (err) {
      console.error('[db] ✗ left-brain tables:', err.message);
    }

    // 6. Graph archive / cold storage (v3 — independent, non-fatal)
    try {
      await client.query(SQL_GRAPH_ARCHIVE);
      console.log('[db] ✓ graph_archive table');
    } catch (err) {
      console.error('[db] ✗ graph_archive table:', err.message);
    }

    console.log('[db] Schema ready.');
  } finally {
    client.release();
  }
}

module.exports = { pool, init };
