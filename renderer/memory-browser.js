'use strict';

// ─── Memory Browser ────────────────────────────────────────────────────────────

let allMemories = [];
let debounceTimer = null;

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function renderCards(memories) {
  const list = document.getElementById('cardList');
  const status = document.getElementById('statusBar');

  if (!memories.length) {
    list.innerHTML = '<div class="insp-empty"><div class="insp-empty-glyph">◈</div>NO MEMORIES FOUND</div>';
    status.textContent = '0 results';
    return;
  }

  status.textContent = `${memories.length} memor${memories.length === 1 ? 'y' : 'ies'}`;

  list.innerHTML = memories.map(m => `
    <div class="card" data-id="${m.id}">
      <div class="card-meta">
        <span class="card-persona">${esc(m.left_by)}</span>
        <span class="card-type">${esc(m.type)}</span>
        ${m.tags?.length ? m.tags.map(t => `<span class="card-tag">${esc(t)}</span>`).join('') : ''}
        <span class="card-date">${fmtDate(m.created_at)}</span>
      </div>
      ${m.title   ? `<div class="card-title">${esc(m.title)}</div>` : ''}
      ${m.subject ? `<div class="card-subject">re: ${esc(m.subject)}</div>` : ''}
      <div class="card-body">${esc(m.body)}</div>
    </div>
  `).join('');

  // Toggle expand on click
  list.querySelectorAll('.card').forEach(card => {
    card.addEventListener('click', () => card.classList.toggle('expanded'));
  });
}

async function load() {
  const persona = document.getElementById('filterPersona').value;
  const type    = document.getElementById('filterType').value;
  const query   = document.getElementById('searchInput').value.trim();

  document.getElementById('statusBar').textContent = 'loading…';

  try {
    let result;
    if (query) {
      result = await window.reef.invoke('memory.search', {
        query,
        ...(persona ? { left_by: persona } : {}),
        ...(type    ? { type }             : {}),
        limit: 200,
      });
    } else {
      result = await window.reef.invoke('memory.list', {
        ...(persona ? { left_by: persona } : {}),
        ...(type    ? { type }             : {}),
        limit: 200,
      });
    }

    if (!result.ok) {
      document.getElementById('cardList').innerHTML =
        `<div class="insp-empty"><div class="insp-empty-glyph">◈</div>ERROR: ${esc(result.error)}</div>`;
      document.getElementById('statusBar').textContent = 'error';
      return;
    }

    allMemories = Array.isArray(result.result) ? result.result : [];
    renderCards(allMemories);

    // Populate entity filter on first load
    if (document.getElementById('filterPersona').options.length === 1) {
      const personas = [...new Set(allMemories.map(m => m.left_by))].sort();
      const sel = document.getElementById('filterPersona');
      personas.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p; opt.textContent = p;
        sel.appendChild(opt);
      });
    }
  } catch (err) {
    document.getElementById('cardList').innerHTML =
      `<div class="insp-empty"><div class="insp-empty-glyph">◈</div>${esc(err.message)}</div>`;
    document.getElementById('statusBar').textContent = 'error';
  }
}

// ─── Event wiring ──────────────────────────────────────────────────────────────

document.getElementById('refreshBtn').addEventListener('click', load);

document.getElementById('filterPersona').addEventListener('change', load);
document.getElementById('filterType').addEventListener('change', load);

document.getElementById('searchInput').addEventListener('input', () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(load, 320);
});

// Initial load
load();
