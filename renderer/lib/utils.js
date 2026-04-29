// ─── Pure utility functions — no state, no DOM ───────────────────────────────

export function uid() { return Math.random().toString(36).slice(2, 10); }

export function escHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatMd(s) {
  // ── Inline formatting — runs inside every block element ──────────────────────
  // NOTE: input is already HTML-escaped, so < is &lt; etc.
  function inline(t) {
    return t
      .replace(/~~(.*?)~~/g, '<s style="opacity:0.55;">$1</s>')
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/g, '<em>$1</em>')
      .replace(/`(.*?)`/g, '<code style="font-family:JetBrains Mono,monospace;font-size:0.85em;background:rgba(255,255,255,0.06);padding:1px 4px;border-radius:2px;">$1</code>')
      // Links — rendered as accent-coloured text; not navigable (Electron safety)
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<span style="color:var(--accent,#00e5c8);opacity:0.85;text-decoration:underline;text-underline-offset:2px;cursor:default;" title="$2">$1</span>');
  }

  // ── Table helpers ─────────────────────────────────────────────────────────────
  function parseCells(row) {
    const cells = row.split('|').map(c => c.trim());
    if (cells[0] === '') cells.shift();
    if (cells[cells.length - 1] === '') cells.pop();
    return cells;
  }
  const isSeparatorRow = (r) => /^\|?[\s\-:|]+\|[\s\-:|]*\|?$/.test(r);

  // ── List helpers ──────────────────────────────────────────────────────────────
  const isUL = (r) => /^[-*+] /.test(r);
  const isOL = (r) => /^\d+\. /.test(r);

  const lines = s.split('\n');
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // ── Fenced code block (``` or ~~~) ────────────────────────────────────────
    const fenceM = line.match(/^(`{3,}|~{3,})(\w*)$/);
    if (fenceM) {
      const fence = fenceM[1];
      const lang  = fenceM[2];
      const codeLines = [];
      let j = i + 1;
      while (j < lines.length && !lines[j].startsWith(fence)) {
        codeLines.push(lines[j]);
        j++;
      }
      const langLabel = lang
        ? `<span style="font-size:0.7em;opacity:0.45;float:right;letter-spacing:0.08em;">${lang}</span>`
        : '';
      out.push(
        `<pre style="margin:8px 0;padding:10px 13px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:4px;overflow-x:auto;line-height:1.55;">`
        + `<code style="font-family:'JetBrains Mono',monospace;font-size:0.82em;color:var(--text,#c8c4bc);">`
        + langLabel
        + codeLines.join('\n')
        + `</code></pre>`
      );
      i = j + 1; // skip closing fence line
      continue;
    }

    // ── Headings ──────────────────────────────────────────────────────────────
    const hm = line.match(/^(#{1,3}) (.+)/);
    if (hm) {
      const lvl = hm[1].length;
      const sz  = ['1.15em', '1.05em', '0.95em'][lvl - 1];
      const mt  = ['14px 0 6px', '12px 0 5px', '10px 0 4px'][lvl - 1];
      out.push(`<h${lvl} style="margin:${mt};font-family:inherit;font-size:${sz};color:var(--text-bright,#e8e4dc);font-weight:600;letter-spacing:0.03em;line-height:1.3;">${inline(hm[2])}</h${lvl}>`);
      i++; continue;
    }

    // ── Horizontal rule ───────────────────────────────────────────────────────
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) {
      out.push('<hr style="border:none;border-top:1px solid rgba(255,255,255,0.12);margin:10px 0;">');
      i++; continue;
    }

    // ── Blockquote (> …) — note: > is already escaped to &gt; ────────────────
    if (line.startsWith('&gt;')) {
      const bqLines = [];
      let j = i;
      while (j < lines.length && lines[j].startsWith('&gt;')) {
        bqLines.push(lines[j].replace(/^&gt;\s?/, ''));
        j++;
      }
      out.push(
        `<blockquote style="margin:6px 0;padding:6px 12px;border-left:3px solid rgba(255,255,255,0.2);color:var(--text-dim,rgba(200,196,188,0.55));font-style:italic;">`
        + bqLines.map(inline).join('<br>')
        + `</blockquote>`
      );
      i = j;
      continue;
    }

    // ── Unordered list (-, *, +) ──────────────────────────────────────────────
    if (isUL(line)) {
      const items = [];
      let j = i;
      while (j < lines.length && isUL(lines[j])) {
        items.push(lines[j].replace(/^[-*+] /, ''));
        j++;
      }
      out.push(
        `<ul style="margin:4px 0 8px;padding-left:1.5em;">`
        + items.map(it => `<li style="margin:2px 0;">${inline(it)}</li>`).join('')
        + `</ul>`
      );
      i = j;
      continue;
    }

    // ── Ordered list (1. 2. …) ────────────────────────────────────────────────
    if (isOL(line)) {
      const items = [];
      let j = i;
      while (j < lines.length && isOL(lines[j])) {
        items.push(lines[j].replace(/^\d+\. /, ''));
        j++;
      }
      out.push(
        `<ol style="margin:4px 0 8px;padding-left:1.5em;">`
        + items.map(it => `<li style="margin:2px 0;">${inline(it)}</li>`).join('')
        + `</ol>`
      );
      i = j;
      continue;
    }

    // ── Table (header + separator + 1+ data rows) ─────────────────────────────
    if (line.includes('|') && i + 1 < lines.length && isSeparatorRow(lines[i + 1])) {
      const headerCells = parseCells(line);
      let j = i + 2;
      const dataRows = [];
      while (j < lines.length && lines[j].includes('|')) {
        dataRows.push(parseCells(lines[j]));
        j++;
      }
      let tbl = '<table style="border-collapse:collapse;margin:8px 0;font-size:0.92em;width:100%;">';
      tbl += '<thead><tr>';
      headerCells.forEach(c => {
        tbl += `<th style="border:1px solid rgba(255,255,255,0.12);padding:5px 10px;text-align:left;background:rgba(255,255,255,0.04);color:var(--text-bright,#e8e4dc);">${inline(c)}</th>`;
      });
      tbl += '</tr></thead><tbody>';
      dataRows.forEach(row => {
        tbl += '<tr>';
        row.forEach(c => {
          tbl += `<td style="border:1px solid rgba(255,255,255,0.08);padding:5px 10px;color:var(--text,#c8c4bc);">${inline(c)}</td>`;
        });
        tbl += '</tr>';
      });
      tbl += '</tbody></table>';
      out.push(tbl);
      i = j;
      continue;
    }

    // ── Regular line ──────────────────────────────────────────────────────────
    out.push(line === '' ? '<br>' : inline(line) + '<br>');
    i++;
  }

  // Strip trailing lone <br>
  while (out.length && out[out.length - 1] === '<br>') out.pop();

  return out.join('');
}

export function timestamp() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function resizeTextarea(ta) {
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
}

export function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function formatDelay(ms) {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3600_000).toFixed(1)}h`;
}
