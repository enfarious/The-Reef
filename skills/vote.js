'use strict';

const { pool } = require('./db');
const message  = require('./message');

// All colony members eligible to vote
const DWELLERS = ['dreamer', 'builder', 'librarian'];
const ALL_VOTERS = [...DWELLERS, 'operator'];

function norm(name) { return (name || '').toLowerCase().trim(); }

// ─── propose ────────────────────────────────────────────────────────────────────
async function propose({ proposer, title, description }) {
  proposer = norm(proposer);
  if (!proposer) throw new Error('proposer is required');
  if (!title || !title.trim()) throw new Error('title is required');

  const { rows } = await pool.query(
    `INSERT INTO votes (proposer, title, description)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [proposer, title.trim(), (description || '').trim()]
  );
  const vote = rows[0];

  // Notify all other colony members
  const recipients = ALL_VOTERS.filter(v => v !== proposer);
  if (recipients.length) {
    try {
      await message.send({
        from: proposer,
        to: recipients,
        subject: `VOTE PROPOSED: ${vote.title}`,
        body: `A vote has been proposed: "${vote.title}"\n\n${vote.description}\n\nCast your vote using vote_cast with vote_id: ${vote.id}. Options: positive, negative, abstain. You must include a narrative explaining your reasoning.`,
      });
    } catch (err) {
      console.error('[vote] Failed to send proposal notification:', err.message);
    }
  }

  return vote;
}

// ─── cast ───────────────────────────────────────────────────────────────────────
async function cast({ voter, vote_id, vote_type, narrative }) {
  voter = norm(voter);
  if (!voter) throw new Error('voter is required');
  if (!vote_id) throw new Error('vote_id is required');
  if (!['positive', 'negative', 'abstain'].includes(vote_type)) {
    throw new Error('vote_type must be "positive", "negative", or "abstain"');
  }
  if (!narrative || !narrative.trim()) {
    throw new Error('narrative is required — explain WHY you are voting this way');
  }

  // Verify vote is open
  const { rows: voteRows } = await pool.query(
    'SELECT * FROM votes WHERE id = $1', [vote_id]
  );
  if (!voteRows.length) throw new Error(`Vote ${vote_id} not found`);
  if (voteRows[0].status !== 'open') {
    throw new Error(`Vote ${vote_id} is ${voteRows[0].status}, not open`);
  }

  // Upsert ballot (allows changing vote before resolution)
  const { rows: ballotRows } = await pool.query(
    `INSERT INTO ballots (vote_id, voter, vote_type, narrative)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (vote_id, voter)
     DO UPDATE SET vote_type = $3, narrative = $4, created_at = NOW()
     RETURNING *`,
    [vote_id, voter, vote_type, narrative.trim()]
  );

  // Try to auto-resolve
  const resolved = await _tryResolve(vote_id);

  return {
    ballot: ballotRows[0],
    vote_status: resolved ? resolved.status : 'open',
    outcome: resolved ? resolved.outcome : null,
  };
}

// ─── table ──────────────────────────────────────────────────────────────────────
async function table({ vote_id, tabled_by, reason }) {
  tabled_by = norm(tabled_by);
  if (!vote_id) throw new Error('vote_id is required');
  if (!reason || !reason.trim()) throw new Error('reason is required for tabling');

  const { rows } = await pool.query(
    `UPDATE votes
     SET status = 'tabled', tabled_by = $2, tabled_reason = $3, resolved_at = NOW()
     WHERE id = $1 AND status = 'open'
     RETURNING *`,
    [vote_id, tabled_by, reason.trim()]
  );
  if (!rows.length) throw new Error(`Vote ${vote_id} not found or not open`);

  const vote = rows[0];

  // Notify everyone
  const recipients = ALL_VOTERS.filter(v => v !== tabled_by);
  try {
    await message.send({
      from: tabled_by || 'system',
      to: recipients,
      subject: `VOTE TABLED: ${vote.title}`,
      body: `The vote "${vote.title}" has been tabled.\n\nReason: ${vote.tabled_reason}\n\nThis is a cooling-down period. The topic can be revisited later with a new proposal.`,
    });
  } catch (err) {
    console.error('[vote] Failed to send table notification:', err.message);
  }

  return vote;
}

// ─── comment ────────────────────────────────────────────────────────────────────
async function comment({ vote_id, author, body }) {
  author = norm(author);
  if (!vote_id) throw new Error('vote_id is required');
  if (!author) throw new Error('author is required');
  if (!body || !body.trim()) throw new Error('body is required');

  // Verify vote exists (any status — comments are for learning from past decisions)
  const { rows: voteRows } = await pool.query(
    'SELECT id FROM votes WHERE id = $1', [vote_id]
  );
  if (!voteRows.length) throw new Error(`Vote ${vote_id} not found`);

  const { rows } = await pool.query(
    `INSERT INTO vote_comments (vote_id, author, body)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [vote_id, author, body.trim()]
  );

  return rows[0];
}

// ─── list ───────────────────────────────────────────────────────────────────────
async function list({ status, limit } = {}) {
  const conditions = [];
  const params = [];
  let idx = 1;

  if (status) {
    conditions.push(`v.status = $${idx++}`);
    params.push(status);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const { rows } = await pool.query(
    `SELECT v.*,
       (SELECT COUNT(*) FROM ballots b WHERE b.vote_id = v.id) AS ballot_count,
       (SELECT COUNT(*) FILTER (WHERE b.vote_type = 'positive') FROM ballots b WHERE b.vote_id = v.id) AS positive_count,
       (SELECT COUNT(*) FILTER (WHERE b.vote_type = 'negative') FROM ballots b WHERE b.vote_id = v.id) AS negative_count,
       (SELECT COUNT(*) FILTER (WHERE b.vote_type = 'abstain') FROM ballots b WHERE b.vote_id = v.id) AS abstain_count,
       (SELECT COUNT(*) FROM vote_comments c WHERE c.vote_id = v.id) AS comment_count
     FROM votes v
     ${where}
     ORDER BY v.created_at DESC
     LIMIT $${idx}`,
    [...params, limit || 50]
  );

  return rows;
}

// ─── detail ─────────────────────────────────────────────────────────────────────
async function detail({ vote_id }) {
  if (!vote_id) throw new Error('vote_id is required');

  const { rows: voteRows } = await pool.query(
    'SELECT * FROM votes WHERE id = $1', [vote_id]
  );
  if (!voteRows.length) throw new Error(`Vote ${vote_id} not found`);

  const { rows: ballots } = await pool.query(
    'SELECT * FROM ballots WHERE vote_id = $1 ORDER BY created_at ASC',
    [vote_id]
  );

  const { rows: comments } = await pool.query(
    'SELECT * FROM vote_comments WHERE vote_id = $1 ORDER BY created_at ASC',
    [vote_id]
  );

  return {
    vote: voteRows[0],
    ballots,
    comments,
  };
}

// ─── Internal: auto-resolve ─────────────────────────────────────────────────────
async function _tryResolve(vote_id) {
  const { rows: ballots } = await pool.query(
    'SELECT voter, vote_type FROM ballots WHERE vote_id = $1',
    [vote_id]
  );

  const ballotMap = {};
  for (const b of ballots) ballotMap[b.voter] = b.vote_type;

  // Count dweller votes
  const dwellerVotes = DWELLERS.filter(d => ballotMap[d]);
  const allDwellersVoted = dwellerVotes.length === DWELLERS.length;

  if (!allDwellersVoted) return null; // wait for all dwellers

  // Tally (excluding abstains)
  let positive = 0, negative = 0;
  for (const v of Object.values(ballotMap)) {
    if (v === 'positive') positive++;
    if (v === 'negative') negative++;
  }

  const operatorVoted = !!ballotMap['operator'];

  // Clear majority among all who have voted?
  if (positive > negative && positive > 1) {
    return _resolve(vote_id, 'positive');
  }
  if (negative > positive && negative > 1) {
    return _resolve(vote_id, 'negative');
  }

  // Tie or narrow — need operator
  if (!operatorVoted) return null; // wait for operator tie-break

  // Operator has voted — recount
  if (positive > negative) return _resolve(vote_id, 'positive');
  if (negative > positive) return _resolve(vote_id, 'negative');

  // Still tied after operator (e.g. operator abstained on a tie)
  // Auto-table
  const { rows } = await pool.query(
    `UPDATE votes
     SET status = 'tabled', tabled_by = 'system', tabled_reason = 'Tie with no deciding vote', resolved_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [vote_id]
  );

  if (rows.length) {
    _notifyAll(rows[0], `The vote "${rows[0].title}" ended in a tie and has been automatically tabled.`);
  }

  return rows[0] || null;
}

async function _resolve(vote_id, outcome) {
  const { rows } = await pool.query(
    `UPDATE votes
     SET status = 'resolved', outcome = $2, resolved_at = NOW()
     WHERE id = $1 AND status = 'open'
     RETURNING *`,
    [vote_id, outcome]
  );

  if (rows.length) {
    const vote = rows[0];
    _notifyAll(vote, `The vote "${vote.title}" has been resolved.\n\nOutcome: ${outcome.toUpperCase()}`);
  }

  return rows[0] || null;
}

async function _notifyAll(vote, body) {
  try {
    await message.send({
      from: 'system',
      to: ALL_VOTERS,
      subject: `VOTE RESOLVED: ${vote.title}`,
      body,
    });
  } catch (err) {
    console.error('[vote] Failed to send resolution notification:', err.message);
  }
}

module.exports = { propose, cast, table, comment, list, detail };
