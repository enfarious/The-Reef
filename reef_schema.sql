-- The Reef database schema (no seed data)
-- Mirrors the runtime schema created by skills/db.js.
-- Safe to run multiple times.

-- Optional extension for trigram similarity indexes.
-- If your DB role cannot install extensions, you can skip this line and the
-- app will still work with full-text search only.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ─────────────────────────────────────────────────────────────────────────────
-- Memories
-- ─────────────────────────────────────────────────────────────────────────────

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

-- Trigram indexes (require pg_trgm extension)
CREATE INDEX IF NOT EXISTS idx_memories_trgm_title   ON memories USING GIN(title   gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_memories_trgm_subject ON memories USING GIN(subject gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_memories_trgm_body    ON memories USING GIN(body    gin_trgm_ops);

-- ─────────────────────────────────────────────────────────────────────────────
-- Messages
-- ─────────────────────────────────────────────────────────────────────────────

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

-- ─────────────────────────────────────────────────────────────────────────────
-- Memory links
-- ─────────────────────────────────────────────────────────────────────────────

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
