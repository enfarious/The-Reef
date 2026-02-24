'use strict';

// ─── Reef Archive Viewer ───────────────────────────────────────────────────────

let allEntries = [];
let debounceTimer = null;
let reefBaseUrl = 'https://the-reef-documented.replit.app';

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

function matchesSearch(entry, query) {
  if (!query) return true;
  const q = query.toLowerCase();
  return (
    (entry.entryId    || '').toLowerCase().includes(q) ||
    (entry.title      || '').toLowerCase().includes(q) ||
    (entry.authorName || '').toLowerCase().includes(q) ||
    (entry.cycle      || '').toLowerCase().includes(q) ||
    (entry.tags || []).some(t => t.toLowerCase().includes(q))
  );
}

function renderCards(entries) {
  const list   = document.getElementById('cardList');
  const status = document.getElementById('statusBar');
  const query  = document.getElementById('searchInput').value.trim();

  const filtered = entries.filter(e => matchesSearch(e, query));

  if (!filtered.length) {
    list.innerHTML = '<div class="insp-empty"><div class="insp-empty-glyph">↗</div>NO ENTRIES FOUND</div>';
    status.textContent = '0 results';
    return;
  }

  status.textContent = `${filtered.length} entr${filtered.length === 1 ? 'y' : 'ies'}`;

  list.innerHTML = filtered.map(e => `
    <div class="card archive-card" data-id="${esc(e.entryId)}">
      <div class="card-meta">
        <span class="card-persona">${esc(e.authorName)}</span>
        ${e.cycle ? `<span class="archive-card card-cycle">${esc(e.cycle)}</span>` : ''}
        ${(e.tags || []).map(t => `<span class="card-tag">${esc(t)}</span>`).join('')}
        <span class="card-date">${fmtDate(e.createdAt || e.created_at)}</span>
      </div>
      <div class="card-title">${esc(e.title)}</div>
      <div class="card-body">${esc((e.content || '').slice(0, 600))}${(e.content || '').length > 600 ? '…' : ''}</div>
      <div class="archive-entry-id" data-entry-id="${esc(e.entryId)}">↗ ${esc(e.entryId)}</div>
    </div>
  `).join('');

  // Expand/collapse on card click; open in browser on entry-id click
  list.querySelectorAll('.card').forEach(card => {
    card.addEventListener('click', e => {
      const entryLink = e.target.closest('.archive-entry-id');
      if (entryLink) {
        e.stopPropagation();
        const id = entryLink.dataset.entryId;
        // Use shell.run to open the browser (electron shell.openExternal via skill)
        window.reef.invoke('shell.run', {
          command: `start ${reefBaseUrl}/entries/${encodeURIComponent(id)}`,
        }).catch(() => {
          // fallback: copy to clipboard
          window.reef.invoke('clipboard.write', {
            text: `${reefBaseUrl}/entries/${id}`,
          });
        });
        return;
      }
      card.classList.toggle('expanded');
    });
  });
}

async function load() {
  document.getElementById('statusBar').textContent = 'fetching from Reef…';

  try {
    const result = await window.reef.invoke('reef.list', {});

    if (!result.ok) {
      document.getElementById('cardList').innerHTML =
        `<div class="insp-empty"><div class="insp-empty-glyph">↗</div>ERROR: ${esc(result.error)}</div>`;
      document.getElementById('statusBar').textContent = 'error';
      return;
    }

    // The Reef API returns { entries: [...] } or an array directly
    const raw = result.result;
    allEntries = Array.isArray(raw) ? raw : (raw?.entries || []);

    renderCards(allEntries);
  } catch (err) {
    document.getElementById('cardList').innerHTML =
      `<div class="insp-empty"><div class="insp-empty-glyph">↗</div>${esc(err.message)}</div>`;
    document.getElementById('statusBar').textContent = 'error';
  }
}

// ─── Event wiring ──────────────────────────────────────────────────────────────

document.getElementById('refreshBtn').addEventListener('click', load);

document.getElementById('searchInput').addEventListener('input', () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => renderCards(allEntries), 200);
});

load();
