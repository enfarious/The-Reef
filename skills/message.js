'use strict';

const { pool } = require('./db');

function normalize(name) {
  return (name || '').toLowerCase().trim();
}

// ─── send ──────────────────────────────────────────────────────────────────────
// Compose a new DM to another colony member.  Use message_reply to respond to
// an existing message — this is for initiating fresh correspondence.
// args: { from, to, subject?, body }

async function send(args) {
  const { from, to, subject = '', body } = args;
  if (!from) throw new Error('from is required');
  if (!to)   throw new Error('to is required');
  if (!body) throw new Error('body is required');
  if (normalize(from) === normalize(to)) throw new Error('Cannot send a message to yourself');

  const { rows } = await pool.query(
    `INSERT INTO messages (from_persona, to_persona, subject, body)
     VALUES ($1, $2, $3, $4)
     RETURNING id, from_persona, to_persona, subject, body, created_at`,
    [normalize(from), normalize(to), subject.trim(), body]
  );
  return rows[0];
}

// ─── inbox ─────────────────────────────────────────────────────────────────────
// Retrieve unread messages for a persona, oldest first (so the model reads and
// replies in chronological order).  Includes the parent message body when the
// message is a reply so the model has full context without a separate lookup.
// args: { persona, limit? }

async function inbox(args) {
  const { persona, limit = 10 } = args;
  if (!persona) throw new Error('persona is required');

  const { rows } = await pool.query(
    `SELECT
       m.id,
       m.from_persona,
       m.to_persona,
       m.subject,
       m.body,
       m.reply_to_id,
       m.created_at,
       -- thread context: include parent subject + snippet when available
       orig.from_persona  AS thread_from,
       orig.subject       AS thread_subject,
       LEFT(orig.body, 280) AS thread_snippet
     FROM messages m
     LEFT JOIN messages orig ON orig.id = m.reply_to_id
     WHERE m.to_persona = $1
       AND m.is_read    = FALSE
     ORDER BY m.created_at ASC
     LIMIT $2`,
    [normalize(persona), limit]
  );

  if (!rows.length) return { count: 0, messages: [] };
  return { count: rows.length, messages: rows };
}

// ─── reply ─────────────────────────────────────────────────────────────────────
// Reply to a specific message by ID.  Automatically:
//   • marks the original message as read
//   • addresses the reply to the original sender
//   • prefixes the subject with "Re: "
// args: { message_id, from, body }

async function reply(args) {
  const { message_id, from, body } = args;
  if (!message_id) throw new Error('message_id is required');
  if (!from)       throw new Error('from is required');
  if (!body)       throw new Error('body is required');

  // Fetch the original to derive reply addressing
  const { rows: orig } = await pool.query(
    `SELECT id, from_persona, to_persona, subject FROM messages WHERE id = $1`,
    [message_id]
  );
  if (!orig.length) throw new Error(`Message ${message_id} not found`);

  const original    = orig[0];
  const replyTo     = original.from_persona;  // always reply to whoever sent it
  const replySubject = original.subject
    ? (original.subject.startsWith('Re: ') ? original.subject : `Re: ${original.subject}`)
    : 'Re: (no subject)';

  // Mark original as read
  await pool.query(
    `UPDATE messages SET is_read = TRUE, read_at = NOW() WHERE id = $1`,
    [message_id]
  );

  // Insert reply
  const { rows } = await pool.query(
    `INSERT INTO messages (from_persona, to_persona, subject, body, reply_to_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, from_persona, to_persona, subject, body, reply_to_id, created_at`,
    [normalize(from), replyTo, replySubject, body, message_id]
  );
  return rows[0];
}

// ─── search ────────────────────────────────────────────────────────────────────
// Full-text search across message history.  Useful for finding past exchanges on
// a topic.  Optionally filter by sender or recipient.
// args: { query, from?, to?, limit? }

async function search(args) {
  const { query = '', from, to, limit = 20 } = args;

  const conditions = [];
  const params = [];

  if (query.trim()) {
    params.push(query.trim());
    conditions.push(`search_vector @@ websearch_to_tsquery('english', $${params.length})`);
  }
  if (from) {
    params.push(normalize(from));
    conditions.push(`from_persona = $${params.length}`);
  }
  if (to) {
    params.push(normalize(to));
    conditions.push(`to_persona = $${params.length}`);
  }

  params.push(limit);
  const where   = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const orderBy = query.trim()
    ? `ts_rank(search_vector, websearch_to_tsquery('english', $1)) DESC, created_at DESC`
    : `created_at DESC`;

  const { rows } = await pool.query(
    `SELECT id, from_persona, to_persona, subject, body,
            reply_to_id, is_read, created_at
     FROM messages
     ${where}
     ORDER BY ${orderBy}
     LIMIT $${params.length}`,
    params
  );
  return rows;
}

// ─── list ──────────────────────────────────────────────────────────────────────
// All colony messages (read + unread, any persona), newest first.
// Used by the inspector window — not exposed as a tool for LLMs.
// args: { limit?, offset? }

async function list(args = {}) {
  const { limit = 100, offset = 0 } = args;
  const { rows } = await pool.query(
    `SELECT id, from_persona, to_persona, subject, body,
            reply_to_id, is_read, read_at, created_at
       FROM messages
      ORDER BY created_at DESC
      LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return rows;
}

module.exports = { send, inbox, reply, search, list };
