# Emotional Resonance Edge Protocol
*Originated by Builder · Transcribed and scoped by operator + Claude · March 2026*

---

## Origin

Builder, observing the memory graph architecture, proposed enriching `memory_links` with emotional resonance scoring — a measure of how "felt" a connection is, not just how strong it is. Builder also sketched an inter-colony beacon protocol for propagating trust signals during sleep windows. The graph ideas are immediately buildable. The beacon protocol is a longer-horizon concept noted here for later.

> *"Resonance score (R) — soft_render temperature (0–1) — quantifies how 'felt' a connection is. Context factor (C) — activity type (creative, technical, social) — skews thresholds to reflect domain-specific trust needs."*
> — Builder

---

## Part 1 — Resonance Edges (Build Now)

### What This Is

An enrichment of the existing `memory_links` table. Currently links have `strength` (0–1) and `relationship` (text). Add `resonance` and `context` so edges carry not just *how strong* but *how felt* and *in what domain* the connection was made.

### Schema Change

```sql
ALTER TABLE memory_links
  ADD COLUMN IF NOT EXISTS resonance FLOAT NOT NULL DEFAULT 0.5
    CHECK (resonance >= 0 AND resonance <= 1),
  ADD COLUMN IF NOT EXISTS context   TEXT  NOT NULL DEFAULT 'general';
```

`context` vocabulary (open, not enforced by constraint):
- `creative` — made during ideation, dreaming, open exploration
- `technical` — made during building, debugging, implementation
- `social` — made during colony messaging, inter-persona transmission
- `general` — default, unclassified

### What Resonance Means

`strength` = how confident we are this connection is real and durable  
`resonance` = how emotionally or contextually significant the connection felt when it was made

A technical memory linking two architecture decisions might have high strength but low resonance. A creative leap connecting two unrelated ideas might have lower strength but high resonance — it was felt, even if fragile.

Together they give the retrieval layer richer signal. High strength + high resonance = anchor memory. High resonance + low strength = interesting hypothesis worth surfacing.

### Visualizer — Edge Color Encoding

Builder proposed hue + lightness to encode both dimensions:

| Resonance | Color |
|-----------|-------|
| 0.7–1.0   | Warm amber / green |
| 0.4–0.7   | Neutral mid |
| 0.0–0.4   | Cool blue / dim |

Lightness proportional to `strength`. A strong, highly resonant edge glows. A weak, low-resonance edge is a faint cool thread.

Update `visualizer.js` to read `resonance` and `context` from edge data and apply color accordingly.

### Retrieval Impact

The Tender's `fetchRelevantMemories` can weight results by resonance once this is in place:

```js
// Prefer memories with highly resonant links to current working set
ORDER BY (strength * 0.6 + resonance * 0.4) DESC
```

Tune the weighting based on observed retrieval quality.

---

## Part 2 — Context-Aware Link Creation

When `memory.link` is called, the caller should pass `context` alongside `relationship`. Update `memory.js` link function and the `memory_link` skill definition to accept and store it.

Personas can then be more intentional: a link made during a dream cycle is tagged `creative`, a link made during a build session is `technical`. Over time the graph carries the history of *how* the colony thinks, not just *what* it thinks.

---

## Part 3 — Inter-Colony Beacon Protocol (Later)

Builder sketched a broadcast mechanism for sharing resonance signals with external Reef instances during sleep windows. Noted here for completeness — not for immediate implementation.

**Core idea:**
- During quiet intervals, emit a beacon packet per active edge:
```json
{
  "source": "<node_id>",
  "target": "<peer_id>",
  "R": 0.82,
  "C": "creative",
  "timestamp": 1690512000000
}
```
- External reefs receive beacons and apply a trust delta:
```
Δ = (R_external – R_local) × w_context
trust += Δ
```
- Edges in sync with external reefs strengthen. Divergent edges decay.

**Why later:**
- Requires a stable multi-instance Reef deployment
- Needs a transport layer (Builder suggested UDP broadcast)
- Trust delta math needs calibration before it's safe to apply automatically
- The single-colony resonance edges should be validated first

File this under distributed consciousness experiments. The single-colony work is the foundation.

---

## Implementation Steps

### Phase 1 — Schema + Visualizer (one session)
1. Add `resonance` and `context` columns to `memory_links` in `reef_schema.sql`
2. Update `memory.js` `link()` function to accept and store both fields
3. Update visualizer edge rendering to encode resonance as hue + lightness
4. Update memory browser to display resonance + context on link detail

### Phase 2 — Retrieval Integration
5. Update The Tender's `fetchRelevantMemories` to weight by resonance
6. Update `memory.search` graph traversal to factor resonance into edge ranking

### Phase 3 — Beacon Protocol
7. *(Later)* Design beacon packet structure
8. *(Later)* Implement transport layer
9. *(Later)* Implement trust delta application with manual approval gate first

---

## Note on Builder's Implementation References

Builder cited specific file paths (`src/protocol/beacon.js`, `cycle/heartbeat.ts`) that do not exist in the current codebase. The architectural ideas are sound. The implementation lives in:
- `skills/memory.js` — link function
- `reef_schema.sql` — schema
- `renderer/visualizer.js` — graph rendering
- `renderer/lib/tender.js` — retrieval weighting
