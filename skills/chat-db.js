'use strict';

const { pool } = require('./db');

async function newSession({ title = 'New Conversation', modelOverride = null } = {}) {
  const { rows } = await pool.query(
    'INSERT INTO chat_sessions (title, model_override) VALUES ($1, $2) RETURNING *',
    [title, modelOverride]
  );
  return rows[0];
}

async function listSessions() {
  const { rows } = await pool.query(
    'SELECT * FROM chat_sessions ORDER BY updated_at DESC LIMIT 100'
  );
  return rows;
}

async function loadSession({ sessionId }) {
  const { rows: sessions } = await pool.query(
    'SELECT * FROM chat_sessions WHERE id = $1',
    [sessionId]
  );
  if (!sessions.length) throw new Error(`Chat session not found: ${sessionId}`);

  const { rows: messages } = await pool.query(
    'SELECT * FROM chat_messages WHERE session_id = $1 ORDER BY created_at ASC',
    [sessionId]
  );
  return { session: sessions[0], messages };
}

async function saveMessage({ sessionId, sender, content, atMentions = [] }) {
  const { rows } = await pool.query(
    `INSERT INTO chat_messages (session_id, sender, content, at_mentions)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [sessionId, sender, content, atMentions]
  );
  await pool.query(
    'UPDATE chat_sessions SET updated_at = NOW() WHERE id = $1',
    [sessionId]
  );
  return rows[0];
}

async function updateTitle({ sessionId, title }) {
  const { rows } = await pool.query(
    'UPDATE chat_sessions SET title = $1 WHERE id = $2 RETURNING *',
    [title, sessionId]
  );
  return rows[0] || null;
}

async function updateModelOverride({ sessionId, modelOverride }) {
  const { rows } = await pool.query(
    'UPDATE chat_sessions SET model_override = $1 WHERE id = $2 RETURNING *',
    [modelOverride || null, sessionId]
  );
  return rows[0] || null;
}

async function updateAtMode({ sessionId, atMode }) {
  const valid = ['queued', 'interrupt'];
  if (!valid.includes(atMode)) throw new Error(`Invalid atMode: "${atMode}"`);
  const { rows } = await pool.query(
    'UPDATE chat_sessions SET at_mode = $1 WHERE id = $2 RETURNING *',
    [atMode, sessionId]
  );
  return rows[0] || null;
}

async function deleteSession({ sessionId }) {
  await pool.query('DELETE FROM chat_sessions WHERE id = $1', [sessionId]);
  return { ok: true };
}

module.exports = { newSession, listSessions, loadSession, saveMessage, updateTitle, updateModelOverride, updateAtMode, deleteSession };
