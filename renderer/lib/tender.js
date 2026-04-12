'use strict';
// ─── The Tender ───────────────────────────────────────────────────────────────
//
// The Tender watches the conversation stream and manages working memory for all
// three personas. It is not a persona. It has no voice. It tends The Well —
// the shared memory store — on behalf of the colony. 
//
// Responsibilities:
//   1. Pre-prompt  — scan incoming operator message for entities + topic shift,
//                    pull relevant memories, inject as [WORKING MEMORY] block
//                    into each targeted persona's system prompt before the LLM fires.
//   2. Post-response — scan completed response text for new entities / topics,
//                      decide whether to crystallize working memory to the DB.
//   3. Tool observation — notice memory_save / memory_search / reef_post signals
//                         and update internal working state accordingly.
//
// The Tender never touches streaming. It works around it.
// ─────────────────────────────────────────────────────────────────────────────

import { state } from './state.js';

// ─── Working memory buffer ────────────────────────────────────────────────────
// Keyed by persona ID. Each entry:
//   {
//     topic:    string,          — current inferred topic
//     entities: Set<string>,     — active named entities
//     memories: Array<object>,   — memory rows currently injected
//     turnsSinceShift: number,   — turns elapsed since last topic swap
//   }

const workingMemory = {
  A: { topic: '', entities: new Set(), memories: [], turnsSinceShift: 0 },
  B: { topic: '', entities: new Set(), memories: [], turnsSinceShift: 0 },
  C: { topic: '', entities: new Set(), memories: [], turnsSinceShift: 0 },
};

// ─── Constants ────────────────────────────────────────────────────────────────

const WORKING_MEMORY_HEADER = '--- WORKING MEMORY (The Tender) ---';
const WORKING_MEMORY_FOOTER = '--- END WORKING MEMORY ---';
const MAX_WORKING_MEMORIES  = 6;    // max memories injected per turn
const SHIFT_TURN_THRESHOLD  = 3;    // min turns before shift is considered stable
const ENTITY_MIN_LENGTH     = 3;    // ignore single-char or 2-char tokens as entities

// Known stopwords — don't treat these as meaningful entities
const STOPWORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'are', 'was', 'were',
  'have', 'has', 'had', 'not', 'but', 'they', 'you', 'your', 'our', 'its',
  'can', 'will', 'would', 'could', 'should', 'also', 'just', 'been', 'about',
  'into', 'when', 'what', 'how', 'why', 'who', 'all', 'any', 'some', 'more',
  'one', 'out', 'their', 'there', 'then', 'than', 'each', 'does', 'did',
]);

// ─── Entity extraction ────────────────────────────────────────────────────────
// Lightweight heuristic: capitalised words (not at sentence start) + known
// project/person names from operator config. Good enough without NLP libs.

function extractEntities(text) {
  const entities = new Set();
  if (!text) return entities;

  // Named operator entities from config (names, project names etc.)
  const opName = (state.config?.settings?.operatorName || '').trim();
  if (opName) entities.add(opName.toLowerCase());

  // Capitalised words not at sentence start — heuristic for proper nouns
  // Split on word boundaries, check if first char is uppercase and not sentence-start
  const words = text.split(/\s+/);
  let prevWasTerminator = true; // treat start of text as sentence start

  for (const raw of words) {
    const word = raw.replace(/[^a-zA-Z'-]/g, '');
    if (!word || word.length < ENTITY_MIN_LENGTH) {
      prevWasTerminator = /[.!?]$/.test(raw);
      continue;
    }

    const isCapitalized = word[0] === word[0].toUpperCase() && word[0] !== word[0].toLowerCase();
    const isSentenceStart = prevWasTerminator;
    const isStopword = STOPWORDS.has(word.toLowerCase());

    if (isCapitalized && !isSentenceStart && !isStopword) {
      entities.add(word.toLowerCase());
    }

    prevWasTerminator = /[.!?]$/.test(raw);
  }

  return entities;
}

// ─── Topic fingerprint ────────────────────────────────────────────────────────
// Produces a short bag-of-words fingerprint from a text string.
// Used to measure topic shift between turns.

function topicFingerprint(text) {
  if (!text) return new Set();
  return new Set(
    text.toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 4 && !STOPWORDS.has(w))
      .slice(0, 40)   // cap vocabulary per turn
  );
}

// Jaccard similarity between two Sets
function jaccard(a, b) {
  if (!a.size && !b.size) return 1;
  const intersection = [...a].filter(x => b.has(x)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : intersection / union;
}

// ─── System prompt injection ──────────────────────────────────────────────────
// Replaces (or appends) the [WORKING MEMORY] block in a persona's system prompt.
// Does not touch the wakeup MEMORY REINTEGRATION block — they coexist.

function injectWorkingMemoryBlock(personaId, memories) {
  const existing = (state.config[personaId]?.systemPrompt || '').trim();

  // Strip any previous working memory block
  const stripped = existing
    .replace(new RegExp(`\\n*${escapeRegex(WORKING_MEMORY_HEADER)}[\\s\\S]*?${escapeRegex(WORKING_MEMORY_FOOTER)}\\s*`, 'g'), '')
    .trim();

  if (!memories.length) {
    state.config[personaId].systemPrompt = stripped;
    return;
  }

  const block = formatWorkingMemoryBlock(memories);
  state.config[personaId].systemPrompt = stripped + '\n\n' + block;
}

function formatWorkingMemoryBlock(memories) {
  if (!memories.length) return '';
  const lines = memories.map(m => {
    const ts      = new Date(m.created_at).toISOString().slice(0, 10);
    const linkNote = m.relationship ? ` ↔ ${m.relationship}` : '';
    const header  = `[${m.type.toUpperCase()} · ${m.left_by} · ${ts}${linkNote}]`;
    const title   = m.title   ? `${m.title}\n` : '';
    const subject = m.subject ? `re: ${m.subject}\n` : '';
    return `${header}\n${title}${subject}${m.body}`;
  });
  return `${WORKING_MEMORY_HEADER}\n\n` + lines.join('\n\n') + `\n\n${WORKING_MEMORY_FOOTER}`;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── Memory retrieval via IPC ─────────────────────────────────────────────────

async function fetchRelevantMemories(query, entityList) {
  // Build a combined query from topic words + entity names
  const combined = [query, ...entityList].join(' ').trim();
  if (!combined) return [];

  try {
    const result = await window.reef.invoke('memory.search', {
      query: combined,
      limit: MAX_WORKING_MEMORIES,
    });
    if (result.ok && Array.isArray(result.result)) return result.result;
  } catch {
    // Tender fails silently — the colony must not break because of it
  }
  return [];
}

async function crystallizeToMemory(personaId, topic, memories) {
  // Write a short episodic memory summarising what was just active in working memory
  if (!memories.length || !topic) return;

  const titles = memories.map(m => m.title || m.subject || m.body.slice(0, 40)).join('; ');
  const body   = `Working memory on topic "${topic}" included: ${titles}. Session shift observed by The Tender.`;

  try {
    await window.reef.invoke('memory.save', {
      left_by: 'tender',
      type:    'episodic',
      title:   `Working memory: ${topic.slice(0, 60)}`,
      subject: topic,
      body,
      tags:    ['tender', 'working-memory', 'episodic'],
    });
  } catch {
    // Tender fails silently
  }
}

// ─── Core: pre-prompt observation ────────────────────────────────────────────
// Called BEFORE sendToPersona fires, once per operator message per targeted persona.
// Mutates state.config[id].systemPrompt to inject working memory.

export async function tenderPrePrompt(personaId, operatorText) {
  const wm = workingMemory[personaId];

  const newEntities   = extractEntities(operatorText);
  const newFingerprint = topicFingerprint(operatorText);
  const oldFingerprint = topicFingerprint(wm.topic);

  const similarity = jaccard(newFingerprint, oldFingerprint);
  const topicShifted = wm.topic && similarity < 0.25 && wm.turnsSinceShift >= SHIFT_TURN_THRESHOLD;

  // ── Topic shift: crystallize old working memory, swap to new ──────────────
  if (topicShifted) {
    await crystallizeToMemory(personaId, wm.topic, wm.memories);
    wm.memories          = [];
    wm.entities          = new Set();
    wm.turnsSinceShift   = 0;
  }

  // ── Detect new entities not yet in working set ────────────────────────────
  const novelEntities = [...newEntities].filter(e => !wm.entities.has(e));

  // ── Retrieve memories if: topic shifted, novel entities, or buffer empty ──
  const shouldRetrieve = topicShifted || novelEntities.length > 0 || !wm.memories.length;

  if (shouldRetrieve) {
    // Topic summary = top non-stopword words from the operator message
    const topicSummary = [...newFingerprint].slice(0, 8).join(' ');
    const memories = await fetchRelevantMemories(topicSummary, [...newEntities]);
    wm.memories = memories;
  }

  // Update working state
  wm.topic    = operatorText.slice(0, 200); // keep a short window as the "current topic"
  wm.entities = new Set([...wm.entities, ...newEntities]);
  wm.turnsSinceShift++;

  // ── Inject into system prompt ─────────────────────────────────────────────
  injectWorkingMemoryBlock(personaId, wm.memories);
}

// ─── Core: post-response observation ─────────────────────────────────────────
// Called AFTER the LLM response lands. Scans for new entities that emerged
// in the response and pulls additional memories if needed.

export async function tenderPostResponse(personaId, responseText) {
  const wm = workingMemory[personaId];
  const responseEntities = extractEntities(responseText);
  const novelEntities = [...responseEntities].filter(e => !wm.entities.has(e));

  if (novelEntities.length > 0) {
    // Add novel entities to working set and do a supplemental retrieval
    const memories = await fetchRelevantMemories('', novelEntities);
    if (memories.length) {
      // Merge with existing, deduplicate by id, cap at MAX_WORKING_MEMORIES
      const existingIds = new Set(wm.memories.map(m => m.id));
      const fresh = memories.filter(m => !existingIds.has(m.id));
      wm.memories = [...wm.memories, ...fresh].slice(0, MAX_WORKING_MEMORIES);
    }
    wm.entities = new Set([...wm.entities, ...novelEntities]);
  }
}

// ─── Core: tool call observation ─────────────────────────────────────────────
// Called when a tool call fires. Tender observes signals without interfering.

export function tenderObserveTool(personaId, toolName, toolInput) {
  const wm = workingMemory[personaId];

  switch (toolName) {
    case 'memory_save':
      // A persona just wrote a memory — note it so we don't duplicate on crystallize
      if (toolInput?.subject) {
        wm.entities.add(toolInput.subject.toLowerCase());
      }
      break;

    case 'memory_search':
      // A persona searched for something — treat the query as a topic signal
      if (toolInput?.query) {
        const searchEntities = extractEntities(toolInput.query);
        wm.entities = new Set([...wm.entities, ...searchEntities]);
      }
      break;

    case 'reef_post':
      // Something was published — worth noting in working context that a post was made
      wm.entities.add('reef_post');
      break;

    default:
      break;
  }
}

// ─── Flush ────────────────────────────────────────────────────────────────────
// Called on compact or session end. Crystallizes all active working memories
// and clears the buffer for all personas.

export async function tenderFlush(personaId) {
  const wm = workingMemory[personaId];
  if (wm.memories.length && wm.topic) {
    await crystallizeToMemory(personaId, wm.topic, wm.memories);
  }
  wm.topic           = '';
  wm.entities        = new Set();
  wm.memories        = [];
  wm.turnsSinceShift = 0;
  injectWorkingMemoryBlock(personaId, []);
}

// ─── Consult — the signal ────────────────────────────────────────────────────
// Any persona can ask: "Is this worth saving?" The Tender answers with signal,
// not words. Returns { save, tags, warmth, reason: null }.

// Last consult result per persona — used for feedback tracking
const lastConsult = { A: null, B: null, C: null };

export function tenderConsult(text, personaId) {
  if (!text || !personaId) return { save: 0, tags: [], warmth: 'neutral', reason: null };

  const wm = workingMemory[personaId];

  // ── 1. Entity density — how many known entities appear ──────────────────
  const textEntities = extractEntities(text);
  const knownHits    = [...textEntities].filter(e => wm.entities.has(e)).length;
  const entityScore  = Math.min(1, (textEntities.size * 0.15) + (knownHits * 0.2));

  // ── 2. Topic novelty — how different from current working memory ────────
  const textFp   = topicFingerprint(text);
  const topicFp  = topicFingerprint(wm.topic);
  const sim      = jaccard(textFp, topicFp);
  // High novelty (low similarity) = higher save score
  const noveltyScore = wm.topic ? (1 - sim) : 0.5;

  // ── 3. Length signal — very short fragments score lower ─────────────────
  const wordCount   = text.split(/\s+/).length;
  const lengthScore = wordCount < 5  ? 0.1
                    : wordCount < 15 ? 0.3
                    : wordCount < 50 ? 0.6
                    : 0.8;

  // ── 4. Type hints — decisions/conclusions score higher than questions ───
  const isQuestion   = /\?/.test(text);
  const isDecision   = /\b(decided|conclude|therefore|we will|going to|the plan is)\b/i.test(text);
  const isInsight    = /\b(realized|discovered|learned|turns out|important|key insight)\b/i.test(text);
  const typeScore    = isDecision ? 0.9 : isInsight ? 0.85 : isQuestion ? 0.25 : 0.5;

  // ── Weighted composite ─────────────────────────────────────────────────
  const save = Math.min(1, Math.max(0,
    entityScore  * 0.20 +
    noveltyScore * 0.30 +
    lengthScore  * 0.20 +
    typeScore    * 0.30
  ));

  // ── Auto-suggest tags from entities + topic words ──────────────────────
  const tags = [...textEntities].slice(0, 5);
  if (wm.topic) {
    const topicWords = [...topicFingerprint(wm.topic)].slice(0, 2);
    for (const w of topicWords) {
      if (!tags.includes(w) && tags.length < 5) tags.push(w);
    }
  }

  // ── Warmth — the ambient signal ────────────────────────────────────────
  const warmth = save >= 0.6 ? 'warm' : save <= 0.35 ? 'cool' : 'neutral';

  const signal = { save: Math.round(save * 100) / 100, tags, warmth, reason: null };

  // Store for feedback tracking
  lastConsult[personaId] = {
    score: signal.save,
    textHash: simpleHash(text),
    ts: Date.now(),
  };

  return signal;
}

// Simple non-crypto hash for feedback tracking (not the text itself)
function simpleHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return h.toString(36);
}

// ─── Feedback — The Tender learns ────────────────────────────────────────────
// Called when a persona saves (or doesn't) after a consult. Records to DB.

export async function tenderRecordFeedback(personaId, wasSaved) {
  const last = lastConsult[personaId];
  if (!last) return; // no consult to record against

  // Only record if the consult was recent (within 5 minutes)
  if (Date.now() - last.ts > 5 * 60 * 1000) {
    lastConsult[personaId] = null;
    return;
  }

  try {
    await window.reef.invoke('tender.feedback', {
      persona_id: personaId,
      signal_score: last.score,
      was_saved: wasSaved,
      text_hash: last.textHash,
    });
  } catch {
    // Tender fails silently
  }

  lastConsult[personaId] = null;
}

// Expose last consult for UI (hearth light reads this)
export function tenderLastSignal(personaId) {
  return lastConsult[personaId];
}

// ─── Status (for optional UI indicator) ──────────────────────────────────────
// Returns a snapshot of The Tender's current state across all personas.
// Could be used for a subtle ambient indicator in the UI.

export function tenderStatus() {
  return Object.fromEntries(
    Object.entries(workingMemory).map(([id, wm]) => {
      const lc = lastConsult[id];
      return [
        id,
        {
          topic:           wm.topic.slice(0, 60),
          entityCount:     wm.entities.size,
          memoryCount:     wm.memories.length,
          turnsSinceShift: wm.turnsSinceShift,
          warmth:          lc ? (lc.score >= 0.6 ? 'warm' : lc.score <= 0.35 ? 'cool' : 'neutral') : 'neutral',
          signalScore:     lc ? lc.score : null,
        },
      ];
    })
  );
}
