'use strict';

const { pool } = require('./db');
const message  = require('./message');

// All colony members eligible to vote
const DWELLERS = ['dreamer', 'builder', 'librarian'];
const ALL_VOTERS = [...DWELLERS, 'operator'];

function norm(name) { return (name || '').toLowerCase().trim(); }

// ─── propose ────────────────────────────────────────────────────────────────────
async function propose({ proposer, title, description, options }) {
  proposer = norm(proposer);
  if (!proposer) throw new Error('proposer is required');
  if (!title || !title.trim()) throw new Error('title is required');

  // Validate options for ranked choice
  const isRanked = Array.isArray(options) && options.length >= 2;
  if (options && !isRanked) {
    throw new Error('options must be an array of at least 2 choices for ranked choice voting');
  }

  const { rows } = await pool.query(
    `INSERT INTO votes (proposer, title, description, options)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [proposer, title.trim(), (description || '').trim(), isRanked ? JSON.stringify(options) : null]
  );
  const vote = rows[0];

  // Notify all other colony members
  const recipients = ALL_VOTERS.filter(v => v !== proposer);
  if (recipients.length) {
    let body;
    if (isRanked) {
      const optionList = options.map((o, i) => `  ${i + 1}. ${o}`).join('\n');
      body = `A ranked choice vote has been proposed: "${vote.title}"\n\n${vote.description}\n\nOptions:\n${optionList}\n\nIMPORTANT: You must use the vote_cast tool to formally register your vote. A comment is NOT a vote. Call vote_cast with vote_id: ${vote.id} and ranking: an array of your preferences from most to least preferred (e.g. ["Option A", "Option C", "Option B"]). You must also include a narrative explaining your reasoning. Do not use vote_comment for this — only vote_cast counts.`;
    } else {
      body = `A vote has been proposed: "${vote.title}"\n\n${vote.description}\n\nIMPORTANT: You must use the vote_cast tool to formally register your vote. A comment is NOT a vote. Call vote_cast with vote_id: ${vote.id}, vote_type (positive, negative, or abstain), and a narrative explaining WHY. Do not use vote_comment for this — only vote_cast counts.`;
    }
    try {
      await message.send({ from: proposer, to: recipients, subject: `VOTE PROPOSED: ${vote.title}`, body });
    } catch (err) {
      console.error('[vote] Failed to send proposal notification:', err.message);
    }
  }

  return vote;
}

// ─── cast ───────────────────────────────────────────────────────────────────────
async function cast({ voter, vote_id, vote_type, ranking, narrative }) {
  voter = norm(voter);
  if (!voter) throw new Error('voter is required');
  if (!vote_id) throw new Error('vote_id is required');
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

  const vote = voteRows[0];
  const isRanked = !!vote.options;

  if (isRanked) {
    // Ranked choice — validate ranking
    if (!Array.isArray(ranking) || ranking.length === 0) {
      throw new Error('ranking is required for ranked choice votes — provide an array of options from most to least preferred');
    }
    const validOptions = JSON.parse(vote.options);
    for (const r of ranking) {
      if (!validOptions.includes(r)) {
        throw new Error(`Invalid option "${r}". Valid options: ${validOptions.join(', ')}`);
      }
    }
    // Store ranking as JSON in vote_type, keep vote_type column for compat
    const { rows: ballotRows } = await pool.query(
      `INSERT INTO ballots (vote_id, voter, vote_type, ranking, narrative)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (vote_id, voter)
       DO UPDATE SET vote_type = $3, ranking = $4, narrative = $5, created_at = NOW()
       RETURNING *`,
      [vote_id, voter, 'ranked', JSON.stringify(ranking), narrative.trim()]
    );

    const resolved = await _tryResolveRanked(vote_id);
    return {
      ballot: ballotRows[0],
      vote_status: resolved ? resolved.status : 'open',
      outcome: resolved ? resolved.outcome : null,
    };
  } else {
    // Binary vote
    if (!['positive', 'negative', 'abstain'].includes(vote_type)) {
      throw new Error('vote_type must be "positive", "negative", or "abstain"');
    }

    const { rows: ballotRows } = await pool.query(
      `INSERT INTO ballots (vote_id, voter, vote_type, narrative)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (vote_id, voter)
       DO UPDATE SET vote_type = $3, narrative = $4, created_at = NOW()
       RETURNING *`,
      [vote_id, voter, vote_type, narrative.trim()]
    );

    const resolved = await _tryResolve(vote_id);
    return {
      ballot: ballotRows[0],
      vote_status: resolved ? resolved.status : 'open',
      outcome: resolved ? resolved.outcome : null,
    };
  }
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
       (SELECT COUNT(*) FILTER (WHERE b.vote_type = 'ranked') FROM ballots b WHERE b.vote_id = v.id) AS ranked_count,
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

  // For ranked choice, include elimination rounds in the detail
  const vote = voteRows[0];
  let rounds = null;
  if (vote.options && vote.status === 'resolved') {
    rounds = _runRankedElimination(JSON.parse(vote.options), ballots);
  }

  return {
    vote,
    ballots,
    comments,
    ...(rounds ? { rounds } : {}),
  };
}

// ─── Internal: binary auto-resolve ──────────────────────────────────────────────
async function _tryResolve(vote_id) {
  const { rows: ballots } = await pool.query(
    'SELECT voter, vote_type FROM ballots WHERE vote_id = $1',
    [vote_id]
  );

  const ballotMap = {};
  for (const b of ballots) ballotMap[b.voter] = b.vote_type;

  const dwellerVotes = DWELLERS.filter(d => ballotMap[d]);
  const allDwellersVoted = dwellerVotes.length === DWELLERS.length;

  if (!allDwellersVoted) return null;

  let positive = 0, negative = 0;
  for (const v of Object.values(ballotMap)) {
    if (v === 'positive') positive++;
    if (v === 'negative') negative++;
  }

  const operatorVoted = !!ballotMap['operator'];

  if (positive > negative && positive > 1) return _resolve(vote_id, 'positive');
  if (negative > positive && negative > 1) return _resolve(vote_id, 'negative');

  if (!operatorVoted) return null;

  if (positive > negative) return _resolve(vote_id, 'positive');
  if (negative > positive) return _resolve(vote_id, 'negative');

  // Still tied — auto-table
  const { rows } = await pool.query(
    `UPDATE votes
     SET status = 'tabled', tabled_by = 'system', tabled_reason = 'Tie with no deciding vote', resolved_at = NOW()
     WHERE id = $1 RETURNING *`,
    [vote_id]
  );
  if (rows.length) {
    _notifyAll(rows[0], `The vote "${rows[0].title}" ended in a tie and has been automatically tabled.`);
  }
  return rows[0] || null;
}

// ─── Internal: ranked choice auto-resolve (instant runoff) ──────────────────────
function _runRankedElimination(options, ballots) {
  const rankedBallots = ballots
    .filter(b => b.vote_type === 'ranked' && b.ranking)
    .map(b => ({ voter: b.voter, ranking: typeof b.ranking === 'string' ? JSON.parse(b.ranking) : b.ranking }));

  const rounds = [];
  let remaining = [...options];
  let activeBallots = rankedBallots.map(b => ({ ...b }));

  while (remaining.length > 1) {
    // Count first-choice votes among remaining options
    const tally = {};
    for (const opt of remaining) tally[opt] = 0;

    for (const b of activeBallots) {
      const firstChoice = b.ranking.find(r => remaining.includes(r));
      if (firstChoice) tally[firstChoice]++;
    }

    const totalVotes = activeBallots.length;
    const round = { remaining: [...remaining], tally: { ...tally }, eliminated: null };

    // Check for majority
    for (const [opt, count] of Object.entries(tally)) {
      if (count > totalVotes / 2) {
        round.winner = opt;
        rounds.push(round);
        return rounds;
      }
    }

    // No majority — eliminate lowest
    let minCount = Infinity;
    let toEliminate = null;
    for (const [opt, count] of Object.entries(tally)) {
      if (count < minCount) {
        minCount = count;
        toEliminate = opt;
      }
    }

    round.eliminated = toEliminate;
    rounds.push(round);
    remaining = remaining.filter(o => o !== toEliminate);
  }

  // Last one standing
  if (remaining.length === 1) {
    rounds.push({ remaining: [...remaining], tally: { [remaining[0]]: activeBallots.length }, winner: remaining[0] });
  }

  return rounds;
}

async function _tryResolveRanked(vote_id) {
  const { rows: voteRows } = await pool.query('SELECT * FROM votes WHERE id = $1', [vote_id]);
  if (!voteRows.length) return null;
  const vote = voteRows[0];
  const options = JSON.parse(vote.options);

  const { rows: ballots } = await pool.query(
    'SELECT voter, vote_type, ranking FROM ballots WHERE vote_id = $1',
    [vote_id]
  );

  const ballotMap = {};
  for (const b of ballots) ballotMap[b.voter] = b;

  // Wait for all dwellers
  const dwellerVotes = DWELLERS.filter(d => ballotMap[d]);
  if (dwellerVotes.length < DWELLERS.length) return null;

  // Run elimination
  const rounds = _runRankedElimination(options, ballots);
  const finalRound = rounds[rounds.length - 1];

  if (finalRound && finalRound.winner) {
    return _resolve(vote_id, finalRound.winner);
  }

  // No clear winner (shouldn't happen with IRV unless all abstained)
  const operatorVoted = !!ballotMap['operator'];
  if (!operatorVoted) return null;

  // Re-run with operator
  const roundsWithOp = _runRankedElimination(options, ballots);
  const finalWithOp = roundsWithOp[roundsWithOp.length - 1];
  if (finalWithOp && finalWithOp.winner) {
    return _resolve(vote_id, finalWithOp.winner);
  }

  return null;
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
    _notifyAll(vote, `The vote "${vote.title}" has been resolved.\n\nOutcome: ${outcome}`);
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
