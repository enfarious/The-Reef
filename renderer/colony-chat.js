'use strict';

// ── Round-robin order (persona IDs) ──────────────────────────────────────────
const RR_ORDER = ['A', 'B', 'C'];

const PERSONA_DEFAULTS = {
  A: { name: 'Dreamer',   color: '#00e5c8' },
  B: { name: 'Builder',   color: '#0097ff' },
  C: { name: 'Librarian', color: '#a855f7' },
};

// ── App state ─────────────────────────────────────────────────────────────────
let cfg = null;          // loaded config
let nameToId = {};       // lowercase name → 'A'|'B'|'C'|'operator'
let idToName = {};       // 'A'|'B'|'C'|'operator' → display name
let operatorName = 'You';
let sessionModelOverride = null;  // null = per persona, string = shared model for session
let sessionAtMode = 'queued';     // 'queued' | 'interrupt'
// Pending @-deliveries for queued mode: { A: [{from, content}], B: [...], C: [...] }
let pendingAtDelivery = { A: [], B: [], C: [] };

let currentSessionId    = null;
let currentSessionTitle = 'New Conversation';
let messages = [];       // [{id, sender, content, at_mentions, created_at}]

// Round-robin state
// Operator is slot #4: A(0) → B(1) → C(2) → Operator → repeat
// lastRRIndex tracks which RR_ORDER slot just went (-1 = round not started)
// When lastRRIndex reaches 2 (C), the next slot is the operator → waitForOp
let lastRRIndex  = -1;   // index in RR_ORDER of last RR speaker (-1 = none)
let waitForOp    = false; // true when operator's turn (after C, or when @'d)

// Queue of pending responses: [{personaId, reason: 'rr'|'at'}]
let queue        = [];
let processing   = false;

// ── Helpers ───────────────────────────────────────────────────────────────────

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtTime(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function fmtDate(dateStr) {
  const d = new Date(dateStr);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  if (isToday) return fmtTime(dateStr);
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

// Build nameToId and idToName from config
function buildNameMaps() {
  nameToId = {};
  idToName = {};
  operatorName = cfg.settings?.operatorName || 'You';

  for (const id of RR_ORDER) {
    const name = cfg[id]?.name || PERSONA_DEFAULTS[id].name;
    nameToId[name.toLowerCase()] = id;
    idToName[id] = name;
  }
  nameToId[operatorName.toLowerCase()] = 'operator';
  nameToId['you'] = 'operator';
  idToName['operator'] = operatorName;
}

// Parse @mentions from text, returns array of unique IDs ('A','B','C','operator')
function parseAtMentions(text) {
  const found = [];
  const seen  = new Set();
  const re    = /@(\w+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const id = nameToId[m[1].toLowerCase()];
    if (id && !seen.has(id)) {
      found.push(id);
      seen.add(id);
    }
  }
  return found;
}

// Render text with @mentions highlighted
function renderBody(text) {
  const escaped = esc(text);
  return escaped.replace(/@(\w+)/g, (full, name) => {
    const id = nameToId[name.toLowerCase()];
    if (!id) return full;
    const color = id === 'operator'
      ? '#e5b840'
      : (cfg[id]?.color || PERSONA_DEFAULTS[id]?.color || '#ffffff');
    return `<span class="at-mention" style="color:${color}">${esc('@')}${esc(name)}</span>`;
  });
}

// ── Session sidebar ───────────────────────────────────────────────────────────

async function loadSessionList() {
  const res = await window.reef.invoke('chat.listSessions', {});
  if (!res.ok) return;
  const sessions = res.result;
  const list = document.getElementById('sessionList');
  list.innerHTML = '';

  if (!sessions.length) {
    list.innerHTML = '<div style="padding:14px;color:var(--text-faint);font-size:11px;">No conversations yet</div>';
    return;
  }

  for (const s of sessions) {
    const item = document.createElement('div');
    item.className = 'session-item' + (s.id === currentSessionId ? ' active' : '');
    item.dataset.id = s.id;
    item.innerHTML = `
      <div class="session-item-title">${esc(s.title)}
        <button class="session-item-delete" data-id="${s.id}" title="Delete">×</button>
      </div>
      <div class="session-item-meta">${fmtDate(s.updated_at)}</div>
    `;
    item.addEventListener('click', (e) => {
      if (e.target.classList.contains('session-item-delete')) return;
      openSession(s.id);
    });
    item.querySelector('.session-item-delete').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete "${s.title}"?`)) return;
      await window.reef.invoke('chat.deleteSession', { sessionId: s.id });
      if (currentSessionId === s.id) clearChat();
      loadSessionList();
    });
    list.appendChild(item);
  }
}

function clearChat() {
  currentSessionId    = null;
  currentSessionTitle = 'New Conversation';
  messages = [];
  resetRRState();
  sessionModelOverride = null;
  sessionAtMode = 'queued';
  pendingAtDelivery = { A: [], B: [], C: [] };
  document.getElementById('feed').innerHTML = '<div id="feedEmpty" class="feed-empty">Start a conversation — everyone is listening.</div>';
  document.getElementById('chatTitle').textContent = 'Colony Chat';
  setRRStatus('');
  document.getElementById('waitingBanner').style.display = 'none';
  document.getElementById('sendBtn').disabled = false;
  document.getElementById('modelSelect').value = '';
  document.getElementById('atModeSelect').value = 'queued';
}

async function openSession(sessionId) {
  const res = await window.reef.invoke('chat.loadSession', { sessionId });
  if (!res.ok) { console.error(res.error); return; }

  currentSessionId    = sessionId;
  currentSessionTitle = res.result.session.title || 'New Conversation';
  messages = res.result.messages;
  sessionModelOverride = res.result.session.model_override || null;
  sessionAtMode = res.result.session.at_mode || 'queued';
  pendingAtDelivery = { A: [], B: [], C: [] };
  resetRRState();

  // Replay state from stored messages to restore RR position
  replayRRState();

  document.getElementById('chatTitle').textContent = res.result.session.title;
  document.getElementById('modelSelect').value = sessionModelOverride || '';
  document.getElementById('atModeSelect').value = sessionAtMode;
  renderFeed();
  loadSessionList(); // refresh active highlight
  setRRStatus(waitForOp ? 'WAITING FOR YOU' : '');

  if (waitForOp) showWaitingBanner(true);
  else           showWaitingBanner(false);
}

// Replay stored messages to restore RR pointer (so resuming a session works)
function replayRRState() {
  resetRRState();
  for (const msg of messages) {
    if (msg.sender === 'operator') {
      const mentions = msg.at_mentions || [];
      if (!mentions.length) {
        // Operator took their turn (slot #4) — next round starts at A
        waitForOp = false;
        lastRRIndex = lastRRIndex === 2 || lastRRIndex === -1 ? -1 : lastRRIndex;
        // We set -1 so the next advance goes to A (index 0)
      }
      // @ operator message doesn't advance RR pointer
    } else if (RR_ORDER.includes(msg.sender)) {
      const idx = RR_ORDER.indexOf(msg.sender);
      const expectedNext = (lastRRIndex + 1) % 3;
      // If this looks like an RR turn (sender is the expected next in sequence)
      if (idx === expectedNext) {
        lastRRIndex = idx;
        if (lastRRIndex === 2) waitForOp = true; // C finished, operator is next
      }
    }
  }
}

// ── Feed rendering ────────────────────────────────────────────────────────────

function renderFeed() {
  const feed = document.getElementById('feed');
  feed.innerHTML = '';

  if (!messages.length) {
    feed.innerHTML = '<div id="feedEmpty" class="feed-empty">Start a conversation — everyone is listening.</div>';
    return;
  }

  for (const msg of messages) {
    feed.appendChild(buildMsgEl(msg));
  }
  scrollToBottom();
}

function buildMsgEl(msg) {
  const el = document.createElement('div');
  el.className = 'msg';
  el.dataset.sender = msg.sender;
  el.dataset.msgId  = msg.id || '';

  const name  = idToName[msg.sender] || msg.sender;
  const color = msg.sender === 'operator'
    ? '#e5b840'
    : (cfg[msg.sender]?.color || PERSONA_DEFAULTS[msg.sender]?.color || '#fff');

  el.innerHTML = `
    <div class="msg-header">
      <span class="msg-sender">${esc(name.toUpperCase())}</span>
      <span class="msg-time">${fmtTime(msg.created_at || new Date().toISOString())}</span>
    </div>
    <div class="msg-body">${renderBody(msg.content)}</div>
  `;
  return el;
}

function appendMsg(msg) {
  const feedEmpty = document.getElementById('feedEmpty');
  if (feedEmpty) feedEmpty.remove();
  const feed = document.getElementById('feed');
  const el = buildMsgEl(msg);
  feed.appendChild(el);
  scrollToBottom();
}

function scrollToBottom() {
  const feed = document.getElementById('feed');
  feed.scrollTop = feed.scrollHeight;
}

// ── Typing indicator ──────────────────────────────────────────────────────────

let typingEl = null;

function showTyping(personaId) {
  removeTyping();
  const name  = idToName[personaId] || personaId;
  const el    = document.createElement('div');
  el.className = 'msg msg-typing';
  el.dataset.sender = personaId;
  el.innerHTML = `
    <div class="msg-header">
      <span class="msg-sender">${esc(name.toUpperCase())}</span>
    </div>
    <div class="msg-body">
      <span class="typing-dot">●</span><span class="typing-dot">●</span><span class="typing-dot">●</span>
    </div>
  `;
  document.getElementById('feed').appendChild(el);
  typingEl = el;
  scrollToBottom();
  setParticipantActive(personaId, true);
}

function removeTyping() {
  if (typingEl) { typingEl.remove(); typingEl = null; }
  setParticipantActive(null, false);
}

function setParticipantActive(id, on) {
  for (const pid of [...RR_ORDER, 'operator']) {
    const el = document.getElementById(`part-${pid === 'operator' ? 'op' : pid}`);
    if (el) el.classList.toggle('active', on && pid === id);
  }
}

// ── RR status display ─────────────────────────────────────────────────────────

function setRRStatus(text) {
  document.getElementById('rrStatus').textContent = text;
}

function showWaitingBanner(show, text = '') {
  const banner = document.getElementById('waitingBanner');
  if (show) {
    document.getElementById('waitingText').textContent = text || 'The colony is listening — your turn.';
    banner.style.display = 'block';
  } else {
    banner.style.display = 'none';
  }
}

// ── RR state helpers ──────────────────────────────────────────────────────────

function resetRRState() {
  lastRRIndex       = -1;
  waitForOp         = false;
  queue             = [];
  processing        = false;
  pendingAtDelivery = { A: [], B: [], C: [] };
}

// ── Routing: decide who responds next ─────────────────────────────────────────
//
// Two @ modes:
//
//   interrupt — @s cause immediate out-of-order responses.
//               LLM @s: first mention only (spiral prevention).
//               Operator @s: all mentions honored (operator has full control).
//
//   queued   — LLM @s are held in pendingAtDelivery and injected as context
//               at the recipient's natural RR turn. No interruption.
//               Operator @s still interrupt (operator has full control).

// routeMessage — called only for operator-sent messages (handleSend)
function routeMessage(content, mentions) {
  if (mentions.length > 0) {
    // Operator @s always interrupt — honor all, skip self-mentions
    for (const id of mentions) {
      if (id !== 'operator') queue.push({ personaId: id, reason: 'at' });
    }
    // Don't change lastRRIndex — operator @ is a mid-round interruption, not a new round
  } else {
    // Operator took their turn (slot #4), so resume from A (slot #0)
    // If round never started (lastRRIndex === -1), also start from A
    waitForOp = false;
    const nextIdx = lastRRIndex === 2 || lastRRIndex === -1 ? 0 : (lastRRIndex + 1) % 3;
    queue.push({ personaId: RR_ORDER[nextIdx], reason: 'rr' });
    lastRRIndex = nextIdx;
  }
}

// advanceRR — queue the next RR persona, or hand off to operator (slot #4)
function advanceRR() {
  if (waitForOp) return;
  if (lastRRIndex === 2) {
    // C just finished — operator is next (slot #4)
    waitForOp = true;
    return;
  }
  const nextIdx = (lastRRIndex + 1) % 3;
  queue.push({ personaId: RR_ORDER[nextIdx], reason: 'rr' });
  lastRRIndex = nextIdx;
  // If we just queued C (index 2), operator follows after C responds —
  // waitForOp will be set when advanceRR() is called again after C's turn.
}

// afterPersonaResponds — called after each LLM response; decides what comes next
//
// RR pointer (lastRRIndex) is only advanced by advanceRR (RR turns), never by @
// responses. This means "resume from the last RR speaker" after an @ chain.
function afterPersonaResponds(personaId, reason, mentions, responseText) {
  if (mentions.length > 0) {
    if (sessionAtMode === 'queued') {
      // Park all @-mentions; RR continues uninterrupted
      for (const id of mentions) {
        if (id === 'operator') waitForOp = true;
        else if (RR_ORDER.includes(id)) {
          pendingAtDelivery[id].push({ from: personaId, content: responseText });
        }
      }
      // Treat as no-@ for RR purposes (fall through to advance below)
    } else {
      // interrupt mode: first @ only
      const first = mentions[0];
      if (first === 'operator') {
        waitForOp = true;
        return; // pause RR; operator must respond before round continues
      }
      queue.push({ personaId: first, reason: 'at' });
      return; // don't advance RR while in @ chain
    }
  }

  // Advance RR (no @ present, or queued mode where @ was parked)
  if (reason === 'rr') {
    advanceRR();
  } else {
    // reason === 'at': @ chain ended (or parked), resume RR
    if (!waitForOp) advanceRR();
  }
}

// ── LLM invocation ────────────────────────────────────────────────────────────

function buildGroupSystemPrompt(personaId) {
  const name = idToName[personaId] || PERSONA_DEFAULTS[personaId].name;
  const others = RR_ORDER
    .filter(id => id !== personaId)
    .map(id => `- ${idToName[id] || PERSONA_DEFAULTS[id].name}`)
    .join('\n');

  return `[GROUP CHAT MODE]
You are ${name.toUpperCase()}, participating in a live group conversation.

Participants in this conversation:
${RR_ORDER.map(id => `- ${idToName[id] || PERSONA_DEFAULTS[id].name}${id === personaId ? ' (you)' : ''}`).join('\n')}
- ${operatorName} (operator)

Rules of this space:
- You may @mention any participant by name to address them directly.
- If your response contains no @mention, it is addressed to the whole group.
- Be conversational. This is a live discussion — respond naturally, not as a monologue.
- Keep your response appropriately sized for the moment.`.trim();
}

function formatTranscript() {
  if (!messages.length) return '[No messages yet]';
  return messages
    .map(m => {
      const name = (idToName[m.sender] || m.sender).toUpperCase();
      return `${name}: ${m.content}`;
    })
    .join('\n\n');
}

async function invokePersona(personaId) {
  const p = cfg[personaId] || {};
  const name = idToName[personaId] || PERSONA_DEFAULTS[personaId].name;

  let endpoint = p.endpoint || '';
  if (!endpoint) {
    appendErrorMsg(personaId, `No endpoint configured for ${name}.`);
    return null;
  }

  const model         = sessionModelOverride || p.model || '';
  const apiKey        = p.apiKey || cfg.global?.apiKey || '';
  const entityPrompt  = (p.systemPrompt || '').trim();
  const basePrompt    = (cfg.settings?.baseSystemPrompt || '').trim();
  const chatHeader    = buildGroupSystemPrompt(personaId);

  const systemPrompt = [chatHeader, basePrompt, entityPrompt].filter(Boolean).join('\n\n---\n\n');

  const transcript  = formatTranscript();

  // In queued mode, inject any pending @-deliveries for this persona
  const pending = pendingAtDelivery[personaId] || [];
  let pendingBlock = '';
  if (pending.length > 0) {
    const lines = pending.map(({ from, content }) => {
      const fromName = (idToName[from] || from).toUpperCase();
      return content
        ? `${fromName} addressed you: "${content}"`
        : `${fromName} mentioned you.`;
    });
    pendingBlock = `\n\n[MESSAGES ADDRESSED TO YOU]\n${lines.join('\n')}`;
    pendingAtDelivery[personaId] = []; // clear after delivery
  }

  const userContent = `[CONVERSATION HISTORY]\n\n${transcript}${pendingBlock}\n\n---\nNow respond as ${name.toUpperCase()}.`;

  showTyping(personaId);

  const res = await window.reef.invoke('llm.complete', {
    endpoint,
    model,
    systemPrompt,
    apiKey,
    messages: [{ role: 'user', content: userContent }],
    store: false,
  });

  removeTyping();

  if (!res.ok) {
    appendErrorMsg(personaId, res.error || 'LLM error');
    return null;
  }

  const text = (res.result?.text || '').trim();
  if (!text) {
    appendErrorMsg(personaId, 'Empty response from model.');
    return null;
  }

  return text;
}

function appendErrorMsg(sender, error) {
  const el = document.createElement('div');
  el.className = 'msg';
  el.dataset.sender = sender;
  el.innerHTML = `
    <div class="msg-header">
      <span class="msg-sender" style="color:#ff4455">${esc((idToName[sender] || sender).toUpperCase())} — ERROR</span>
    </div>
    <div class="msg-body" style="color:#ff4455;font-size:12px;">${esc(error)}</div>
  `;
  const feedEmpty = document.getElementById('feedEmpty');
  if (feedEmpty) feedEmpty.remove();
  document.getElementById('feed').appendChild(el);
  scrollToBottom();
}

// ── Queue processing ──────────────────────────────────────────────────────────

async function processQueue() {
  if (processing) return;
  processing = true;
  setInput(false);

  try {
    while (queue.length > 0) {
      const { personaId, reason } = queue.shift();

      // Update RR status display
      {
        const name = idToName[personaId] || PERSONA_DEFAULTS[personaId].name;
        const slot = reason === 'rr' ? `RR[${lastRRIndex + 1}/4]` : '@';
        setRRStatus(`${slot} — ${name.toUpperCase()}`);
      }

      const text = await invokePersona(personaId);
      if (!text) break; // error — stop processing

      const mentions = parseAtMentions(text);

      // Save to DB
      const saveRes = await window.reef.invoke('chat.saveMessage', {
        sessionId:  currentSessionId,
        sender:     personaId,
        content:    text,
        atMentions: mentions,
      });
      if (saveRes.ok) {
        const saved = saveRes.result;
        messages.push(saved);
        appendMsg(saved);
      } else {
        // Still show message even if save failed
        const fakeMsg = { sender: personaId, content: text, at_mentions: mentions, created_at: new Date().toISOString() };
        messages.push(fakeMsg);
        appendMsg(fakeMsg);
      }

      // Auto-title once, when session still has the default name
      if (currentSessionId && currentSessionTitle === 'New Conversation') {
        const firstOp = messages.find(m => m.sender === 'operator');
        if (firstOp) {
          const title = firstOp.content.slice(0, 60).replace(/\n/g, ' ').trim();
          if (title && title !== 'New Conversation') {
            await window.reef.invoke('chat.updateTitle', { sessionId: currentSessionId, title });
            currentSessionTitle = title;
            document.getElementById('chatTitle').textContent = title;
            await loadSessionList();
          }
        }
      }

      // Determine what comes next
      afterPersonaResponds(personaId, reason, mentions, text);

      if (waitForOp && queue.length === 0) break;
    }
  } finally {
    processing = false;

    if (waitForOp) {
      showWaitingBanner(true);
      setRRStatus('WAITING FOR YOU');
    } else {
      showWaitingBanner(false);
      setRRStatus('');
    }

    setInput(true);
    await loadSessionList();
  }
}

function setInput(enabled) {
  document.getElementById('chatInput').disabled = !enabled;
  document.getElementById('sendBtn').disabled   = !enabled;
}

// ── Send handler ──────────────────────────────────────────────────────────────

async function handleSend() {
  const input = document.getElementById('chatInput');
  const text  = input.value.trim();
  if (!text) return;
  if (processing) return;

  // Ensure a session exists
  if (!currentSessionId) {
    const res = await window.reef.invoke('chat.newSession', {});
    if (!res.ok) { alert('Could not create session: ' + res.error); return; }
    currentSessionId = res.result.id;
    loadSessionList();
  }

  input.value = '';
  autoResize(input);

  const mentions = parseAtMentions(text);

  // Save operator message
  const saveRes = await window.reef.invoke('chat.saveMessage', {
    sessionId:  currentSessionId,
    sender:     'operator',
    content:    text,
    atMentions: mentions,
  });

  const msg = saveRes.ok
    ? saveRes.result
    : { sender: 'operator', content: text, at_mentions: mentions, created_at: new Date().toISOString() };

  messages.push(msg);
  appendMsg(msg);
  showWaitingBanner(false);

  // Route
  routeMessage(text, mentions);

  // Process — if operator @'d only the operator themselves, nothing to do
  if (queue.length > 0) {
    processQueue();
  } else if (!waitForOp) {
    setRRStatus('');
  }
}

// ── Model selector ────────────────────────────────────────────────────────────

function initModelSelector() {
  const sel = document.getElementById('modelSelect');
  sel.addEventListener('change', async () => {
    const val = sel.value || null;
    sessionModelOverride = val;
    if (currentSessionId) {
      await window.reef.invoke('chat.updateModelOverride', {
        sessionId: currentSessionId,
        modelOverride: val,
      });
    }
  });

  const btn = document.getElementById('modelRefreshBtn');
  btn.addEventListener('click', () => populateModelSelector());
}

async function populateModelSelector() {
  const sel = document.getElementById('modelSelect');
  const btn = document.getElementById('modelRefreshBtn');
  const current = sel.value;

  // Loading state
  while (sel.options.length > 1) sel.remove(1);
  const loadingOpt = new Option('loading…', '__loading__', false, false);
  loadingOpt.disabled = true;
  sel.add(loadingOpt);
  if (btn) { btn.textContent = '…'; btn.disabled = true; }

  // Collect unique endpoint+apiKey combos from persona config
  const endpointMap = new Map(); // "endpoint|apiKey" → { endpoint, apiKey, names[] }
  for (const id of RR_ORDER) {
    const p = cfg[id] || {};
    const endpoint = p.endpoint || '';
    const apiKey   = p.apiKey || cfg.global?.apiKey || '';
    if (!endpoint) continue;
    const key = `${endpoint}|${apiKey}`;
    if (!endpointMap.has(key)) {
      endpointMap.set(key, { endpoint, apiKey, names: [] });
    }
    endpointMap.get(key).names.push(idToName[id] || id);
  }

  // Fetch from all unique endpoints in parallel
  const fetches = [...endpointMap.values()].map(async ({ endpoint, apiKey, names }) => {
    const res = await window.reef.invoke('llm.models', { endpoint, apiKey });
    if (!res.ok) return { endpoint, names, models: [], error: res.error };
    return { endpoint, names, models: res.result || [], error: null };
  });

  const results = await Promise.all(fetches);

  // Restore button
  if (btn) { btn.textContent = '⟳'; btn.disabled = false; }

  // Rebuild options
  while (sel.options.length > 1) sel.remove(1);

  const multiEndpoint = results.length > 1;
  let totalModels = 0;

  for (const { endpoint, names, models, error } of results) {
    if (error) {
      const errOpt = new Option(`⚠ ${names.join('/')} — ${error}`, '__err__', false, false);
      errOpt.disabled = true;
      sel.add(errOpt);
      continue;
    }

    if (!models.length) continue;

    // Group header when multiple endpoints
    if (multiEndpoint) {
      const header = new Option(`── ${names.join('/')} ──`, '__hdr__', false, false);
      header.disabled = true;
      sel.add(header);
    }

    // Sort: loaded first, then alpha
    const sorted = [...models].sort((a, b) => {
      if (a.state === 'loaded' && b.state !== 'loaded') return -1;
      if (a.state !== 'loaded' && b.state === 'loaded') return  1;
      return a.id.localeCompare(b.id);
    });

    for (const m of sorted) {
      const dot   = m.state === 'loaded' ? '● ' : '○ ';
      const quant = m.quantization ? ` [${m.quantization}]` : '';
      const opt   = new Option(dot + m.id + quant, m.id);
      if (m.state !== 'loaded') opt.style.opacity = '0.55';
      sel.add(opt);
      totalModels++;
    }
  }

  if (totalModels === 0 && results.every(r => !r.error)) {
    const none = new Option('— no models returned —', '__none__', false, false);
    none.disabled = true;
    sel.add(none);
  }

  // Restore previous selection if still available, else "Per persona"
  sel.value = current;
  if (!sel.value) sel.value = '';
  sessionModelOverride = sel.value || null;
}

// ── @ mode selector ───────────────────────────────────────────────────────────

function initAtModeSelect() {
  const sel = document.getElementById('atModeSelect');
  sel.value = sessionAtMode;
  sel.addEventListener('change', async () => {
    sessionAtMode = sel.value;
    pendingAtDelivery = { A: [], B: [], C: [] }; // clear stale pending on mode switch
    if (currentSessionId) {
      await window.reef.invoke('chat.updateAtMode', {
        sessionId: currentSessionId,
        atMode: sessionAtMode,
      });
    }
  });
}

// ── Init ──────────────────────────────────────────────────────────────────────

function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 160) + 'px';
}

async function init() {
  const res = await window.reef.loadConfig();
  if (!res.ok) { console.error('Failed to load config'); return; }
  cfg = res.result;
  buildNameMaps();

  // Update participant badge labels
  for (const id of RR_ORDER) {
    const el = document.getElementById(`part-${id}`);
    if (el) {
      const name = idToName[id];
      el.textContent = name[0].toUpperCase();
      el.title       = name;
    }
  }
  const opEl = document.getElementById('part-op');
  if (opEl) {
    opEl.textContent = operatorName[0].toUpperCase();
    opEl.title       = operatorName;
  }

  initModelSelector();
  initAtModeSelect();
  populateModelSelector(); // async — runs in background, updates selector when ready
  await loadSessionList();

  // New session button
  document.getElementById('newSessionBtn').addEventListener('click', async () => {
    const res = await window.reef.invoke('chat.newSession', {});
    if (!res.ok) return;
    currentSessionId    = res.result.id;
    currentSessionTitle = 'New Conversation';
    messages = [];
    sessionModelOverride = null;
    sessionAtMode = 'queued';
    resetRRState();
    renderFeed();
    document.getElementById('chatTitle').textContent = 'New Conversation';
    document.getElementById('modelSelect').value = '';
    document.getElementById('atModeSelect').value = 'queued';
    showWaitingBanner(false);
    setRRStatus('');
    loadSessionList();
    document.getElementById('chatInput').focus();
  });

  // Send button + Enter key
  document.getElementById('sendBtn').addEventListener('click', handleSend);
  document.getElementById('chatInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  });
  document.getElementById('chatInput').addEventListener('input', function () {
    autoResize(this);
  });

  // Auto-open a fresh session if none exist
  const listRes = await window.reef.invoke('chat.listSessions', {});
  if (listRes.ok && listRes.result.length > 0) {
    await openSession(listRes.result[0].id);
  } else {
    // Create first session automatically
    const newRes = await window.reef.invoke('chat.newSession', {});
    if (newRes.ok) {
      currentSessionId = newRes.result.id;
      loadSessionList();
    }
  }

  document.getElementById('chatInput').focus();
}

document.addEventListener('DOMContentLoaded', init);
