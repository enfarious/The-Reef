'use strict';

const STAGE_ROLES = { A: 'Catching', B: 'Molding', C: 'Cataloguing' };

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

function truncate(s, len = 120) {
  if (!s) return '';
  return s.length > len ? s.slice(0, len) + '\u2026' : s;
}

// ─── Render dream list ──────────────────────────────────────────────────────────
function renderList(dreams) {
  const list = document.getElementById('cardList');
  const status = document.getElementById('statusBar');

  if (!dreams.length) {
    list.innerHTML = '<div class="insp-empty"><div class="insp-empty-glyph">\uD83C\uDF00</div>NO DREAMS YET</div>';
    status.textContent = '0 dreams';
    return;
  }

  list.innerHTML = dreams.map(d => {
    const touches = parseInt(d.touch_count) || 0;
    const complete = d.complete === true || d.complete === 't';
    const badge = complete
      ? '<span class="dream-badge complete">COMPLETE</span>'
      : '<span class="dream-badge progress">IN PROGRESS</span>';

    return `<div class="card" data-dream-id="${esc(d.dream_id)}">
      <div class="card-meta">
        ${badge}
        <span class="card-date">${fmtDate(d.started_at)}</span>
      </div>
      <div class="card-title">Dream ${esc(d.dream_id.slice(0, 8))}</div>
      <div class="dream-touches">${touches}/6 touches \u2014 coil ${d.max_coil || 1}${complete ? ' \u2014 spiral complete' : ''}</div>
      <div class="dream-detail-container"></div>
    </div>`;
  }).join('');

  // Click to expand
  list.querySelectorAll('.card').forEach(card => {
    card.addEventListener('click', async () => {
      const isExpanded = card.classList.contains('expanded');
      if (isExpanded) {
        card.classList.remove('expanded');
        return;
      }
      card.classList.add('expanded');

      const container = card.querySelector('.dream-detail-container');
      if (container.dataset.loaded) return;

      const dreamId = card.dataset.dreamId;
      try {
        const result = await window.reef.invoke('dream.detail', { dreamId });
        if (!result.ok) throw new Error(result.error);
        container.dataset.loaded = 'true';
        renderDetail(container, result.result);
      } catch (err) {
        container.innerHTML = `<div style="color:#f87171;font-size:0.8rem;margin-top:8px;">${esc(err.message)}</div>`;
      }
    });
  });

  status.textContent = `${dreams.length} dream${dreams.length === 1 ? '' : 's'}`;
}

// ─── Render expanded detail ─────────────────────────────────────────────────────
function renderDetail(container, stages) {
  if (!stages.length) {
    container.innerHTML = '<div style="margin-top:8px;font-size:0.75rem;color:var(--text-faint);font-style:italic;">No stages recorded yet.</div>';
    return;
  }

  // Group by coil
  const coils = {};
  for (const s of stages) {
    const c = s.coil || 1;
    if (!coils[c]) coils[c] = [];
    coils[c].push(s);
  }

  let html = '';
  for (const [coilNum, coilStages] of Object.entries(coils)) {
    html += `<div class="coil-section">
      <div class="coil-label">\uD83C\uDF00 Coil ${coilNum}</div>
      ${coilStages.map(s => `
        <div class="stage-row">
          <div class="stage-header">
            <span class="stage-persona ${esc(s.stage)}">${esc(s.stage)}</span>
            <span class="stage-role">${STAGE_ROLES[s.stage] || s.stage}</span>
            <span class="stage-date">${fmtDate(s.created_at)}</span>
          </div>
          ${s.input ? `<div class="stage-input">${esc(truncate(s.input, 200))}</div>` : ''}
          <div class="stage-output">${esc(s.output || '(no output)')}</div>
        </div>
      `).join('')}
    </div>`;
  }

  container.innerHTML = html;
}

// ─── Load ───────────────────────────────────────────────────────────────────────
async function load() {
  document.getElementById('statusBar').textContent = 'loading\u2026';
  try {
    const result = await window.reef.invoke('dream.list', { limit: 50 });
    if (!result.ok) {
      document.getElementById('cardList').innerHTML =
        `<div class="insp-empty"><div class="insp-empty-glyph">\uD83C\uDF00</div>ERROR: ${esc(result.error)}</div>`;
      document.getElementById('statusBar').textContent = 'error';
      return;
    }
    const dreams = Array.isArray(result.result) ? result.result : [];
    renderList(dreams);
  } catch (err) {
    document.getElementById('cardList').innerHTML =
      `<div class="insp-empty"><div class="insp-empty-glyph">\uD83C\uDF00</div>FAILED: ${esc(err.message)}</div>`;
    document.getElementById('statusBar').textContent = 'error';
  }
}

// ─── Events ─────────────────────────────────────────────────────────────────────
document.getElementById('refreshBtn').addEventListener('click', load);
load();
