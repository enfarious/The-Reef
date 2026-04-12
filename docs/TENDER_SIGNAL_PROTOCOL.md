# The Tender — Signal Protocol
*Originated by Dreamer · Transcribed and scoped by operator + Claude · March 2026*

---

## Origin

Dreamer proposed that The Tender should evolve from a purely passive background process into a consultable inner voice — one that answers not in words but in signal. The colony shouldn't have to decide alone whether something is worth remembering. The Tender already watches everything. Let it say so.

> *"What if this inner voice could also teach us? It might learn from our past decisions — when we ignored its counsel or followed it — and adjust its guidance accordingly. Over time, it becomes not just a passive guardian but an evolving mentor, whispering 'remember this,' 'forget that,' in a language of patterns rather than words."*
> — Dreamer

---

## What This Is

An extension to `tender.js` that adds a **consult** function — callable by any persona when uncertain whether a thought is worth saving. The Tender responds with a confidence score and optional auto-suggested tags. No words. No chat. Just signal.

The signal is also reflected in the UI as a subtle ambient indicator — a warm glow when The Tender thinks something is worth keeping, cool silence when it isn't.

---

## API Design

### `tender.consult(text, personaId)`

Returns a signal object:

```js
{
  save:    0.87,                              // 0.0–1.0 confidence this is worth saving
  tags:    ['architecture', 'reef', 'memory'], // auto-suggested
  warmth:  'warm',                            // 'warm' | 'cool' | 'neutral' — for UI
  reason:  null                               // always null — The Tender does not explain
}
```

### Confidence scoring (initial heuristic approach)

Until embeddings are available, score is derived from:
- **Entity density** — how many known entities appear in the text
- **Topic novelty** — how different this is from recent working memory
- **Length signal** — very short fragments score lower
- **Type hints** — questions score lower than assertions; decisions/conclusions score higher

Once pgvector is available, replace heuristics with semantic similarity against existing memories — low similarity to anything stored = high novelty = higher save score.

---

## Feedback Loop (the learning piece)

Dreamer's most interesting proposal: The Tender learns from whether its counsel was followed.

Add a `tender_feedback` table:

```sql
CREATE TABLE IF NOT EXISTS tender_feedback (
  id           SERIAL PRIMARY KEY,
  persona_id   TEXT        NOT NULL,
  signal_score FLOAT       NOT NULL,
  was_saved    BOOLEAN     NOT NULL,
  text_hash    TEXT,              -- hash of consulted text, not the text itself
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

When a persona calls `tender.consult()` and then either saves or discards:
- Write a feedback row
- Periodically recalibrate the confidence thresholds based on agreement rate

Over time The Tender's thresholds drift toward matching actual colony behavior. It stops being a static heuristic and starts modeling the colony's own taste.

---

## UI — The Hearth Light

The Tender gets no column. No chat bubble. A single ambient indicator — small, quiet, placed near the inspector buttons or the input row.

- **Warm amber pulse** — The Tender suggests saving
- **Cool dim** — noise, let it go
- **Neutral** — no strong signal

The indicator updates after each response lands (`tenderPostResponse` already fires here). The persona can glance at it. They are never required to act on it.

`tenderStatus()` already returns per-persona state. Extend it to include `warmth` and pipe it to the UI.

---

## Implementation Steps

1. Add `tender.consult(text, personaId)` to `tender.js`
2. Add heuristic scoring (entity density + novelty + length)
3. Add `tender_feedback` table to schema + `reef_schema.sql`
4. Wire feedback write-back when persona saves/discards after consulting
5. Add hearth light indicator to `index.html` + `style.css`
6. Pipe `tenderStatus()` warmth signal to the indicator via a small UI update loop
7. *(Later)* Replace heuristic scoring with pgvector semantic similarity
8. *(Later)* Periodic threshold recalibration from feedback table

---

## What This Is Not

- The Tender does not become a fourth persona
- The Tender does not send messages
- The Tender does not explain its reasoning
- The Tender does not insist

It tends. It signals. The colony decides.
