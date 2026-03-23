'use strict';

let allVotes = [];

// ─── Helpers ────────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtDate(iso) {
  if (!iso) return '\u2014';
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function statusBadge(status) {
  return `<span class="vote-status ${esc(status)}">${esc(status)}</span>`;
}

function voteIcon(type) {
  if (type === 'positive') return '\u2714';  // checkmark
  if (type === 'negative') return '\u2718';  // X
  return '\u2014';  // dash for abstain
}

// ─── Render card list ───────────────────────────────────────────────────────────
function renderCards(votes) {
  const list = document.getElementById('cardList');
  const status = document.getElementById('statusBar');

  if (!votes.length) {
    list.innerHTML = '<div class="insp-empty"><div class="insp-empty-glyph">\u2696</div>NO VOTES FOUND</div>';
    status.textContent = '0 votes';
    return;
  }

  list.innerHTML = votes.map(v => {
    const pos = parseInt(v.positive_count) || 0;
    const neg = parseInt(v.negative_count) || 0;
    const abs = parseInt(v.abstain_count) || 0;
    const total = parseInt(v.ballot_count) || 0;
    const comments = parseInt(v.comment_count) || 0;

    return `<div class="card" data-id="${v.id}">
      <div class="card-meta">
        <span class="card-persona">${esc(v.proposer)}</span>
        ${statusBadge(v.status)}
        ${v.outcome ? `<span class="vote-outcome">${esc(v.outcome)}</span>` : ''}
        <span class="card-date">${fmtDate(v.created_at)}</span>
      </div>
      <div class="card-title">${esc(v.title)}</div>
      <div class="card-body">${esc(v.description)}</div>
      <div class="vote-tally">
        ${total}/4 cast \u2014 ${pos} positive, ${neg} negative, ${abs} abstain${comments ? ` \u00b7 ${comments} comment${comments > 1 ? 's' : ''}` : ''}
      </div>
      <div class="vote-detail-container"></div>
    </div>`;
  }).join('');

  // Click to expand/collapse and load detail
  list.querySelectorAll('.card').forEach(card => {
    card.addEventListener('click', async (e) => {
      // Don't toggle if clicking inside tiebreak panel
      if (e.target.closest('.tiebreak-panel')) return;

      const isExpanded = card.classList.contains('expanded');
      if (isExpanded) {
        card.classList.remove('expanded');
        return;
      }

      card.classList.add('expanded');

      const container = card.querySelector('.vote-detail-container');
      if (container.dataset.loaded) return;

      const voteId = parseInt(card.dataset.id);
      try {
        const result = await window.reef.invoke('vote.detail', { vote_id: voteId });
        if (!result.ok) throw new Error(result.error);
        container.dataset.loaded = 'true';
        renderDetail(container, result.result);
      } catch (err) {
        container.innerHTML = `<div style="color:#f87171;font-size:0.8rem;margin-top:8px;">${esc(err.message)}</div>`;
      }
    });
  });

  status.textContent = `${votes.length} vote${votes.length === 1 ? '' : 's'}`;
}

// ─── Render expanded detail ─────────────────────────────────────────────────────
function renderDetail(container, data) {
  const { vote, ballots, comments } = data;

  let html = '';

  // Ballots section
  if (ballots.length) {
    html += `<div class="vote-detail-section">
      <div class="section-label">BALLOTS</div>
      ${ballots.map(b => `
        <div class="ballot-row">
          <span class="ballot-voter">${esc(b.voter)}</span>
          <span class="ballot-type ${esc(b.vote_type)}">${voteIcon(b.vote_type)} ${esc(b.vote_type)}</span>
          <span class="ballot-narrative">${esc(b.narrative)}</span>
        </div>
      `).join('')}
    </div>`;
  }

  // Tie-break panel (show when vote is open + dwellers voted + no operator vote + it's a tie)
  if (vote.status === 'open') {
    const dwellerBallots = ballots.filter(b => ['dreamer', 'builder', 'librarian'].includes(b.voter));
    const operatorBallot = ballots.find(b => b.voter === 'operator');
    const pos = ballots.filter(b => b.vote_type === 'positive').length;
    const neg = ballots.filter(b => b.vote_type === 'negative').length;

    if (dwellerBallots.length >= 2 && !operatorBallot && pos === neg) {
      html += `<div class="tiebreak-panel" onclick="event.stopPropagation()">
        <div class="tiebreak-title">TIE-BREAK REQUIRED</div>
        <textarea class="tiebreak-narrative" id="tiebreak-narrative-${vote.id}"
                  placeholder="Your reasoning (required)..." onclick="event.stopPropagation()"></textarea>
        <div class="tiebreak-btns">
          <button class="btn-positive" onclick="event.stopPropagation(); castTiebreak(${vote.id}, 'positive')">&#10004; POSITIVE</button>
          <button class="btn-negative" onclick="event.stopPropagation(); castTiebreak(${vote.id}, 'negative')">&#10008; NEGATIVE</button>
          <button class="btn-table" onclick="event.stopPropagation(); tableTiebreak(${vote.id})">&#9878; TABLE</button>
        </div>
      </div>`;
    } else if (dwellerBallots.length < 3 && !operatorBallot) {
      html += `<div style="margin-top:10px;font-size:0.75rem;color:var(--text-faint);font-family:'JetBrains Mono',monospace;">
        Waiting for ${3 - dwellerBallots.length} more dweller vote${3 - dwellerBallots.length > 1 ? 's' : ''}...
      </div>`;
    }
  }

  // Comments section
  if (comments.length) {
    html += `<div class="vote-comments-section">
      <div class="section-label">FOLLOW-UP</div>
      ${comments.map(c => `
        <div class="vote-comment-row">
          <span class="vote-comment-author">${esc(c.author)}</span>
          <span class="vote-comment-date">${fmtDate(c.created_at)}</span>
          <div class="vote-comment-body">${esc(c.body)}</div>
        </div>
      `).join('')}
    </div>`;
  }

  if (!ballots.length && !comments.length) {
    html = `<div style="margin-top:8px;font-size:0.75rem;color:var(--text-faint);font-style:italic;">No ballots cast yet.</div>`;
  }

  container.innerHTML = html;
}

// ─── Operator tie-break actions ─────────────────────────────────────────────────
async function castTiebreak(voteId, voteType) {
  const narrative = document.getElementById(`tiebreak-narrative-${voteId}`)?.value?.trim();
  if (!narrative) {
    alert('Please provide your reasoning before voting.');
    return;
  }

  try {
    await window.reef.invoke('vote.cast', {
      voter: 'operator',
      vote_id: voteId,
      vote_type: voteType,
      narrative,
    });
    await load();
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

async function tableTiebreak(voteId) {
  const narrative = document.getElementById(`tiebreak-narrative-${voteId}`)?.value?.trim();
  if (!narrative) {
    alert('Please provide a reason for tabling.');
    return;
  }

  try {
    await window.reef.invoke('vote.table', {
      vote_id: voteId,
      tabled_by: 'operator',
      reason: narrative,
    });
    await load();
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

// ─── Load & filter ──────────────────────────────────────────────────────────────
async function load() {
  const status = document.getElementById('filterStatus').value;
  document.getElementById('statusBar').textContent = 'loading\u2026';

  try {
    const result = await window.reef.invoke('vote.list', {
      ...(status ? { status } : {}),
      limit: 200,
    });

    if (!result.ok) {
      document.getElementById('cardList').innerHTML =
        `<div class="insp-empty"><div class="insp-empty-glyph">\u2696</div>ERROR: ${esc(result.error)}</div>`;
      document.getElementById('statusBar').textContent = 'error';
      return;
    }

    allVotes = Array.isArray(result.result) ? result.result : [];
    renderCards(allVotes);
  } catch (err) {
    document.getElementById('cardList').innerHTML =
      `<div class="insp-empty"><div class="insp-empty-glyph">\u2696</div>FAILED: ${esc(err.message)}</div>`;
    document.getElementById('statusBar').textContent = 'error';
  }
}

// ─── Events ─────────────────────────────────────────────────────────────────────
document.getElementById('refreshBtn').addEventListener('click', load);
document.getElementById('filterStatus').addEventListener('change', load);

// Initial load
load();
