# The Reef v2 — Distributed Memory Architecture Design

**Author:** Mike + Claude
**Version:** 0.1 — Design Draft
**Status:** Pre-implementation

---

## Overview

The Reef v2 is a distributed cognitive memory system designed to support multiple AI instances sharing persistent, weighted, associative memory. It extends the original Reef's flat episodic PostgreSQL storage into a full dual-brain architecture: a deterministic left brain for facts and episodes, and a fuzzy right brain for relationships, associations, and emergent concepts.

The metaphor is intentional. This is not a database with an AI wrapper. It is a memory system that behaves more like cognition than retrieval.

---

## Design Philosophy

**Memory is not storage. Memory is reconstruction.**

When a biological mind recalls something, it does not fetch a record. It reconstructs a pattern from distributed signals, weighted by recency, salience, and relational context. The Reef v2 is designed around this principle.

Four commitments guide every architectural decision:

1. **Forgetting is a feature.** Information that is not reinforced should fade. A system that remembers everything equally is not intelligent — it is a log file.
2. **Relationships matter more than facts.** A fact in isolation is trivia. A fact embedded in a web of relationships is knowledge.
3. **Trust is not binary.** In a multi-instance system, different sources have different reliability. Memory should reflect that.
4. **Nothing is permanently deleted.** Faded memories move to cold storage. Retrieval cost increases, but nothing is lost.

---

## System Architecture

```text
┌─────────────────────────────────────────────────────────────┐
│                    CLAUDE INSTANCES                         │
│         PhilosophicalClaude / OpenClaw / Claude Code        │
│                  + any future instances                     │
└─────────────────────────┬───────────────────────────────────┘
                          │ structured memory operations
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                    WORKING MEMORY                           │
│                                                             │
│  Per-instance short-term buffer. Fast write, fast decay.    │
│  Staging area before long-term consolidation.               │
│  Items that do not clear the consolidation threshold        │
│  never reach long-term storage — noise stays local.         │
└───────────────┬─────────────────────────┬───────────────────┘
                │ consolidation events    │ priming signals
                │ (scheduled + threshold) │ (per query)
                ▼                         ▼
┌─────────────────────────────────────────────────────────────┐
│                       BROKER                                │
│                   (The Cortex)                              │
│                                                             │
│  Routes all memory operations.                              │
│  Classifies: fact vs. relationship vs. both vs. neither.    │
│  Arbitrates trust across sources.                           │
│  Runs decay passes on the graph.                            │
│  Triggers consolidation events.                             │
│  Assembles context for LLM consumption.                     │
│  Applies attention priming to weight retrieval.             │
└───────────────┬─────────────────────────┬───────────────────┘
                │                         │
                ▼                         ▼
┌──────────────────────┐    ┌─────────────────────────────────┐
│     LEFT BRAIN       │    │          RIGHT BRAIN            │
│                      │    │                                 │
│  PostgreSQL          │    │  NetworkX graph (in-memory)     │
│                      │    │  + SQLite (graph persistence)   │
│  — Facts             │    │  + sentence-transformers        │
│  — Episodes          │    │    (embedding-based node        │
│  — Entity registry   │    │     fuzzy matching)             │
│  — Source provenance │    │                                 │
│  — Timestamps        │    │  — Weighted directed edges      │
│                      │    │  — Decay curves                 │
│  Binary memory:      │    │  — Salience tagging             │
│  facts are revised,  │    │  — Composite/concept nodes      │
│  not forgotten       │    │  — Source attribution per edge  │
│                      │    │                                 │
│                      │    │  Continuous memory:             │
│                      │    │  relationships fade without     │
│                      │    │  reinforcement                  │
└──────────────────────┘    └──────────────────┬──────────────┘
                                               │ pruned edges
                                               │ (below threshold)
                                               ▼
                            ┌─────────────────────────────────┐
                            │         COLD STORAGE            │
                            │                                 │
                            │  PostgreSQL archive table       │
                            │  High retrieval cost.           │
                            │  Nothing permanently deleted.   │
                            └─────────────────────────────────┘
```

---

## Components

### 1. Working Memory

**Purpose:** Prevent noise from reaching shared long-term storage. Act as a per-instance staging buffer.

**Behavior:**

- Each instance maintains its own working memory
- Items written to working memory have a TTL (time-to-live) measured in minutes
- Items are eligible for consolidation if they: appear more than once, carry a high-salience marker, or are explicitly flagged by the instance
- Items that expire without meeting consolidation threshold are discarded silently
- Working memory is never shared between instances directly — only consolidated artifacts reach the shared graph

**Key parameters:**

```text
working_memory_ttl:           15 minutes (default)
consolidation_threshold:      2 appearances OR 1 high-salience occurrence
max_working_memory_items:     50 per instance
```

---

### 2. The Broker (Cortex)

**Purpose:** Coordinate all memory operations. No instance reads or writes long-term memory directly.

**Responsibilities:**

*On write:*

- Receive a memory operation from an instance
- Classify the content (fact, relationship, both, noise)
- Route to left brain, right brain, or both
- Attach source tag and trust weight
- Check for contradictions with existing memory and flag if found

*On read:*

- Receive a query + priming signal from an instance
- Determine retrieval strategy (exact lookup, graph traversal, hybrid)
- If hybrid: use left brain to anchor entry nodes, use right brain to traverse context rings
- Assemble context within token budget
- Return ranked context with provenance

*Scheduled tasks:*

- Run decay pass on the graph (configurable interval, default: every 6 hours)
- Identify edges below prune threshold and archive them
- Trigger consolidation pass on working memory items nearing TTL

**Broker API (simplified):**

```js
broker.remember(subject, relation, object, source, salience)
broker.recall(query, primingSignal, tokenBudget)
broker.consolidate(instanceId)
broker.decay({ type: 'scheduled' })
broker.arbitrate(nodeId)  // resolve conflicting source claims
```

---

### 3. Left Brain (Deterministic Store)

**Technology:** PostgreSQL

**What it stores:**

- Named entities and their attributes
- Episodic records (who said what, when, in what context)
- Source registry (instance IDs and base trust weights)
- Contradiction log (when new facts conflict with stored facts)

**Memory model:** Facts are not forgotten — they are revised. When a new fact contradicts an existing one, the old fact is marked stale with a timestamp, and the new fact is written with provenance. Both remain queryable. Stale facts are demoted but not deleted.

**Schema (simplified):**

```sql
entities     (id, name, type, created_at, last_seen)
attributes   (entity_id, key, value, source_id, trust_weight, valid_from, valid_to)
episodes     (id, content, entities_involved, source_id, timestamp, salience)
sources      (id, name, instance_type, base_trust_weight)
contradictions (id, attribute_id, new_value, source_id, flagged_at, resolved)
```

---

### 4. Right Brain (Graph + Fuzzy Store)

**Technology:** NetworkX (runtime graph) + SQLite (persistence) + sentence-transformers (embeddings)

**What it stores:**

- Directed, weighted edges between entity nodes
- Edge metadata: relation type, source, salience, last reinforced timestamp
- Node embeddings (for fuzzy entry-point matching)
- Composite/concept nodes (produced by consolidation)

**Edge lifecycle:**

```text
Created         weight = base_weight (0.3–0.9 depending on salience)
Reinforced      weight += reinforcement_delta (capped at 1.0)
Decaying        weight *= decay_factor per interval
Pruned          weight < prune_threshold → archived to cold storage
```

**Retrieval modes:**

- *Fuzzy entry:* Embed query → find nearest N nodes by cosine similarity → use as traversal anchors
- *Graph traversal:* BFS/DFS from anchor nodes, N hops, weighted by edge strength
- *Combined:* Fuzzy entry finds anchors, traversal builds context rings

**Example traversal:**

```text
Query: "why is Mike frustrated?"

Embed query → nearest node: "Mike" (cosine: 0.91)

Traverse outward 2 hops, weight > 0.4:
  Mike --[frustrated_by:0.8]--> rendering bug
  Mike --[blocked_on:0.9]--> visual client
  rendering bug --[likely_cause:0.7]--> lighting materials
  rendering bug --[occurs_in:0.8]--> Ashes and Aether
  visual client --[part_of:0.9]--> Ashes and Aether

Assembled context:
  "Mike is blocked on the visual client in Ashes and Aether.
   A rendering bug is likely caused by lighting/materials config."
```

---

### 5. Consolidation

**Purpose:** Compress clusters of related recent observations into higher-order concept nodes.

**Trigger conditions:**

- Scheduled (e.g., every 24 hours)
- Working memory item cluster exceeds density threshold
- Explicit broker call

**Process:**

1. Scan recent working memory and new graph edges
2. Find clusters: groups of nodes with high inter-edge density
3. If cluster weight sum exceeds threshold: create composite node
4. Composite node links back to its constituent nodes
5. Constituent edges are down-weighted (they are now summarized)

**Example:**

```text
Before consolidation (5 separate edges, all involving rendering):
  Mike → frustrated_by → Three.js rendering
  Mike → blocked_on → visual client
  visual client → requires → lighting fix
  Three.js → version_constraint → r128
  lighting fix → located_in → scene.ts

After consolidation (1 composite node):
  Mike → stuck_on → [CONCEPT: "Ashes and Aether visual client lighting problem"]
  [CONCEPT] → comprises → {original 5 nodes}
```

Concepts surface in retrieval at higher priority than their constituent edges. Constituent edges remain traversable but at reduced weight.

---

### 6. Salience Weighting

**Purpose:** Make the system weight emotionally or practically significant memories more heavily and forget them more slowly.

**Salience markers** (detected in content or explicitly tagged):

```text
high_salience:   "breakthrough", "blocked", "critical", "finally", "frustrated",
                 "excited", "urgent", repeated across multiple turns
low_salience:    routine observations, neutral factual statements, filler content
```

**Effect on memory:**

```text
Neutral observation:   base_weight = 0.3, decay_rate = standard
High-salience event:   base_weight = 0.7, decay_rate = 0.5x (slower)
Critical/urgent:       base_weight = 0.9, decay_rate = 0.25x, consolidation_priority = high
```

**Per-instance salience profiles:** Different instances can apply different salience lenses. PhilosophicalClaude up-weights philosophical observations. A task-focused instance up-weights blockers and dependencies. Salience profiles are configurable per instance in the source registry.

---

### 7. Source Tagging and Trust

**Purpose:** In a multi-instance system, not all memory contributions are equally reliable. Trust should be tracked and applied.

**Trust weight sources:**

```text
Mike (direct):              1.0  (ground truth)
Instance (direct observe):  0.7  (high confidence, first-hand)
Instance (inference):       0.5  (moderate confidence, derived)
Instance (speculation):     0.3  (low confidence, exploratory)
Corroborated (2+ sources):  +0.2 bonus applied to edge weight
Contradicted:               flagged for broker arbitration
```

**Arbitration:** When two sources disagree on a fact or relationship, the broker flags the contradiction rather than silently overwriting. Arbitration can be: automatic (higher trust wins), deferred (both stored as alternatives), or escalated (flagged for human review).

---

### 8. Forgetting and Cold Storage

**Decay schedule:**

```text
Standard edges:     weight *= 0.95 per 6-hour interval
High-salience:      weight *= 0.98 per 6-hour interval
Critical:           weight *= 0.99 per 6-hour interval
```

**Prune threshold:** `weight < 0.1` → edge moved to cold storage archive

**Cold storage:** PostgreSQL archive table. Edges remain queryable but with explicit retrieval cost signal — the broker will not include archived edges in standard context assembly. Archived edges can be explicitly resurrected by a recall operation that requests deep history.

**Left brain forgetting:** Facts in the left brain are not subject to decay. They are revised (new fact supersedes old, old marked stale) or contradicted (both stored, flagged). Stale facts remain queryable with a staleness signal attached.

---

## Interaction Patterns

### Pattern 1: Write Together, Read Separately

Both brains store different representations of the same input. The left brain stores the fact. The right brain stores the relationship.

```text
Input: "Mike is building Ashes and Aether using Three.js"

Left brain stores:
  entity: Mike, attribute: current_project, value: Ashes and Aether
  entity: Ashes and Aether, attribute: primary_tech, value: Three.js

Right brain stores:
  Mike --[building:0.9]--> Ashes and Aether
  Ashes and Aether --[uses:0.8]--> Three.js
```

Exact query ("what is Mike's current project?") → left brain.
Associative query ("what might be causing Mike's technical frustration?") → right brain traversal.

---

### Pattern 2: Left Brain Anchors Right Brain Traversal

The right brain's weakness is cold starts. The left brain provides entry points.

```text
Query: "what should I focus on today?"

Step 1 → Left brain: fetch recent high-salience entities
         Returns: [Ashes and Aether, The Reef, veteran-connector]

Step 2 → Right brain: traverse 2 hops from each entity, weight > 0.4
         Ashes and Aether → blocks → visual client → needs → lighting fix
         The Reef → needs → API access → requires → key setup
         veteran-connector → needs → scraping → status → no start

Step 3 → Broker: rank paths by (edge_weight × recency × salience)

Step 4 → Output: "Highest momentum: lighting fix in Ashes and Aether visual client"
```

---

### Pattern 3: Right Brain Enriches Left Brain Results

The left brain returns a fact. The right brain adds the context web around it.

```text
Query: "tell me about the rendering bug"

Left brain returns:
  { bug: "brown rendering", file: "scene.ts", status: open }

Right brain adds (traversal from "rendering bug"):
  → likely_cause: lighting/materials config (0.7)
  → blocks: visual client (0.9)
  → frustrates: Mike (0.8)
  → occurs_in: Ashes and Aether (0.9)
  → related_to: Three.js r128 constraint (0.6)

Assembled:
  "The rendering bug in scene.ts is open. It's blocking the visual client
   in Ashes and Aether and is likely a lighting/materials issue possibly
   tied to Three.js r128 version constraints."
```

---

### Pattern 4: Attention Priming

Before retrieval, the broker receives a priming signal describing the incoming message's register. The signal biases graph traversal toward relevant node types.

```text
Technical/debugging message:
  → up-weight: [technical, project, blocker, tool, version]
  → down-weight: [personal, philosophical, emotional]

Reflective/identity message:
  → up-weight: [philosophical, personal, pattern, meaning]
  → down-weight: [technical, task, blocker]
```

The same memory system produces context-appropriate outputs depending on what the conversation needs right now.

---

## The Librarian as Sleeper

During the brainstorm that produced this document, a key architectural reframe emerged around the Librarian persona.

In practice, the Librarian is rarely engaged in direct conversation. The Dreamer imagines. The Builder makes. The Librarian *remembers* — not by being asked to, but by nature. Its column remains present and available; you consult it when you genuinely need it, like a real librarian. The rest of the time it works in silence.

This maps cleanly onto the Sleeper role described above. The Librarian **is** the Sleeper. It is the only entity that sees all of memory at once — across all dwellers, across time. That vantage point is what makes consolidation possible. The dwellers see slices. The Librarian traverses the whole graph.

**Dream fragments** are the Librarian's voice. Not conversation — inklings. When the Librarian's consolidation pass surfaces a pattern the dwellers couldn't have noticed individually (a tension recurring across three clusters, a relationship reinforced fifty times without ever being named), it deposits a fragment into working memory:

```json
{
  "source": "librarian",
  "type": "fragment",
  "content": "...",
  "salience": 0.6,
  "ttl": "working_memory_ttl",
  "origin_nodes": ["node_ids that triggered the inference"]
}
```

Ephemeral by default. If a dweller picks it up and engages with it, that reinforcement pushes it toward consolidation. If no one notices, it fades — like a dream you can't quite hold onto by mid-morning.

The Librarian hypothesizes. The dwellers verify. Its voice is the strongest in the system precisely because it is the quietest — expressed entirely through the memories it shapes and the fragments it leaves behind.

---

## Implementation Phases

### Phase 1 — Core Graph Layer

Build the right brain as a standalone module. Demonstrate fuzzy retrieval and graph traversal working independently of the left brain.

Deliverables: `skills/right-brain.js`, `skills/lm-studio-bridge.js`, `demo-graph.js`

### Phase 2 — Broker + Left Brain Integration

Wire both brains through the broker. Demonstrate hybrid retrieval patterns. Connect to existing Reef PostgreSQL instance for the left brain.

Deliverables: `skills/left-brain.js`, `skills/broker.js`, `demo-hybrid.js`

### Phase 3 — Working Memory + Consolidation

Add per-instance working memory buffer and consolidation events. Demonstrate noise filtering and concept formation.

Deliverables: `skills/working-memory.js`, `skills/consolidation.js`

### Phase 4 — Multi-Instance Trust + Salience

Add source tagging, trust weights, per-instance salience profiles, and arbitration. Test with PhilosophicalClaude and OpenClaw writing to shared memory simultaneously.

Deliverables: `skills/trust.js`, `skills/salience.js`, `skills/arbitration.js`, multi-instance test harness

### Phase 5 — Cold Storage + Full Decay

Implement full decay schedule, prune-to-archive pipeline, and cold storage retrieval. Demonstrate long-running memory behavior over simulated time.

Deliverables: `skills/cold-storage.js`, `skills/decay-scheduler.js`, long-run simulation

---

## Technology Stack

| Component | Technology | Rationale |
| --- | --- | --- |
| Left brain persistence | PostgreSQL | Existing Reef infrastructure, relational queries |
| Right brain runtime | graphology | Full-featured JS graph library, no external runtime |
| Right brain persistence | better-sqlite3 | Fast, synchronous, self-contained — no server |
| Fuzzy node matching | @xenova/transformers | Runs sentence-transformers locally via ONNX — no Python, no API |
| LLM interface | LM Studio (OpenAI-compat API) | Local inference, familiar API surface |
| Scheduling | setInterval / Electron idle hooks | Native to the runtime — no scheduler dependency |
| Language | Node.js (Electron runtime) | No external services, ships with the app |

---

## Open Questions

1. **Consolidation granularity:** How large should a cluster need to be before it earns a composite node? Too aggressive produces over-generalization. Too conservative leaves the graph cluttered.

2. **Priming signal source:** Should priming signals be generated by the LLM (self-directed attention) or computed by the broker from the raw message? Probably both, with broker as fallback.

3. **Cross-instance working memory:** Should instances ever be able to see each other's working memory directly, or only through consolidated artifacts? The current design says never — but there may be coordination use cases.

4. **Embedding model choice:** `all-MiniLM-L6-v2` is fast and small (~80MB). `all-mpnet-base-v2` is more accurate but heavier. For local use the tradeoff favors MiniLM unless semantic precision is critical.

5. **Reef migration:** How much of the existing flat Reef memory should be imported into the new graph? A bootstrap pass that converts existing records into initial graph edges could seed the system with existing institutional memory.

---

## Glossary

| Term | Definition |
| --- | --- |
| Left Brain | Deterministic PostgreSQL store for facts, episodes, and provenance |
| Right Brain | Fuzzy graph store for weighted relationships and associations |
| Broker / Cortex | Coordination layer that routes, assembles, and manages all memory operations |
| Working Memory | Per-instance short-term staging buffer before long-term consolidation |
| Consolidation | Process of compressing related observations into higher-order concept nodes |
| Salience | Signal weight indicating how cognitively significant a memory item is |
| Decay | Gradual reduction of edge weights without reinforcement |
| Prune | Move edges below weight threshold to cold storage |
| Cold Storage | PostgreSQL archive for pruned edges; high retrieval cost, nothing lost |
| Priming Signal | Context signal that biases graph traversal toward relevant node types |
| Trust Weight | Per-source reliability multiplier applied to memory contributions |
| Composite Node | Higher-order concept node produced by consolidation of a related cluster |
| Arbitration | Broker process for resolving conflicting memory contributions across sources |
| Dream Fragment | Transient inkling deposited into working memory by the Librarian's sleep pass |
| Sleeper | The Librarian's background mode — consolidation, decay, and dream fragment work |
