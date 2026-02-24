'use strict';

// ─── Colony Messages Viewer ───────────────────────────────────────────────────

let allMessages = [];

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

function applyFilters(messages) {
  const persona = document.getElementById('filterPersona').value;
  const readFilter = document.getElementById('filterRead').value;

  return messages.filter(m => {
    if (persona && m.from_persona !== persona && m.to_persona !== persona) return false;
    if (readFilter === 'unread' && m.is_read) return false;
    if (readFilter === 'read'   && !m.is_read) return false;
    return true;
  });
}

function renderCards(messages) {
  const list   = document.getElementById('cardList');
  const status = document.getElementById('statusBar');

  if (!messages.length) {
    list.innerHTML = '<div class="insp-empty"><div class="insp-empty-glyph">✉</div>NO MESSAGES FOUND</div>';
    status.textContent = '0 results';
    return;
  }

  status.textContent = `${messages.length} message${messages.length === 1 ? '' : 's'}`;

  list.innerHTML = messages.map(m => `
    <div class="card msg-card ${m.is_read ? '' : 'unread'}" data-id="${m.id}">
      ${m.is_read ? '' : '<div class="msg-unread-dot"></div>'}
      <div class="msg-route">
        <strong>${esc(m.from_persona)}</strong>
        <span style="opacity:0.5"> → </span>
        <strong>${esc(m.to_persona)}</strong>
        ${m.reply_to_id ? `<span style="opacity:0.4"> (reply to #${m.reply_to_id})</span>` : ''}
        <span class="card-date">${fmtDate(m.created_at)}</span>
      </div>
      ${m.subject ? `<div class="msg-subject-line">${esc(m.subject)}</div>` : ''}
      <div class="msg-body-text">${esc(m.body)}</div>
    </div>
  `).join('');

  list.querySelectorAll('.card').forEach(card => {
    card.addEventListener('click', () => card.classList.toggle('expanded'));
  });
}

async function load() {
  document.getElementById('statusBar').textContent = 'loading…';

  try {
    const result = await window.reef.invoke('message.list', { limit: 500 });

    if (!result.ok) {
      document.getElementById('cardList').innerHTML =
        `<div class="insp-empty"><div class="insp-empty-glyph">✉</div>ERROR: ${esc(result.error)}</div>`;
      document.getElementById('statusBar').textContent = 'error';
      return;
    }

    allMessages = Array.isArray(result.result) ? result.result : [];

    // Populate persona filter on first load
    if (document.getElementById('filterPersona').options.length === 1) {
      const personas = [...new Set([
        ...allMessages.map(m => m.from_persona),
        ...allMessages.map(m => m.to_persona),
      ])].sort();
      const sel = document.getElementById('filterPersona');
      personas.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p; opt.textContent = p;
        sel.appendChild(opt);
      });
    }

    renderCards(applyFilters(allMessages));
  } catch (err) {
    document.getElementById('cardList').innerHTML =
      `<div class="insp-empty"><div class="insp-empty-glyph">✉</div>${esc(err.message)}</div>`;
    document.getElementById('statusBar').textContent = 'error';
  }
}

function refilter() {
  renderCards(applyFilters(allMessages));
}

// ─── Event wiring ──────────────────────────────────────────────────────────────

document.getElementById('refreshBtn').addEventListener('click', load);
document.getElementById('filterPersona').addEventListener('change', refilter);
document.getElementById('filterRead').addEventListener('change', refilter);

load();
