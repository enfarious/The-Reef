'use strict';

// ─── Consolidation — Working Memory → Concept Nodes ───────────────────────────
//
// Compresses clusters of related working memory items into higher-order concept
// nodes in the right-brain graph.
//
// Process:
//  1. Fetch pending items (≥2 appearances OR high-salience) for a persona.
//  2. Embed all items using the right-brain embedder.
//  3. Cluster by cosine similarity > CLUSTER_THRESHOLD.
//  4. For clusters of MIN_CLUSTER_SIZE+: create a composite concept node.
//  5. Link cluster members → concept node in the graph.
//  6. Mark all consolidated items in SQLite.

const workingMemory = require('./working-memory');
const rightBrain    = require('./right-brain');

const CLUSTER_THRESHOLD = 0.65;
const MIN_CLUSTER_SIZE  = 3;

// ─── Cosine similarity (same as right-brain's internal) ──────────────────────

function cosine(a, b) {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot  += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

// ─── runFor ──────────────────────────────────────────────────────────────────
// args: { personaId }
// Returns: { conceptsCreated, itemsConsolidated, clusters }

async function runFor({ personaId } = {}) {
  if (!personaId) throw new Error('consolidation.runFor: personaId is required');

  const pending = workingMemory.pendingConsolidation({ personaId });

  if (pending.length < MIN_CLUSTER_SIZE) {
    return { conceptsCreated: 0, itemsConsolidated: 0, clusters: [],
             note: `Only ${pending.length} eligible items — minimum ${MIN_CLUSTER_SIZE} needed` };
  }

  // ── Embed all items ────────────────────────────────────────────────────────
  const embedded = [];
  for (const item of pending) {
    try {
      const vec = await rightBrain.embed({ text: item.content });
      embedded.push({ item, vec: new Float32Array(vec) });
    } catch {
      // right-brain might not be ready — skip this item
    }
  }

  if (embedded.length < MIN_CLUSTER_SIZE) {
    return { conceptsCreated: 0, itemsConsolidated: 0, clusters: [],
             note: 'Embedding failed for too many items' };
  }

  // ── Greedy clustering by cosine similarity ─────────────────────────────────
  const used     = new Set();
  const clusters = [];

  // Sort by salience descending — highest-salience item seeds each cluster
  const sorted = [...embedded].sort((a, b) => b.item.salience - a.item.salience);

  for (let i = 0; i < sorted.length; i++) {
    if (used.has(i)) continue;
    const seed    = sorted[i];
    const cluster = [seed];
    used.add(i);

    for (let j = i + 1; j < sorted.length; j++) {
      if (used.has(j)) continue;
      if (cosine(seed.vec, sorted[j].vec) >= CLUSTER_THRESHOLD) {
        cluster.push(sorted[j]);
        used.add(j);
      }
    }

    if (cluster.length >= MIN_CLUSTER_SIZE) {
      clusters.push(cluster);
    }
  }

  if (!clusters.length) {
    return { conceptsCreated: 0, itemsConsolidated: 0, clusters: [],
             note: 'No clusters reached minimum size' };
  }

  // ── Create concept nodes and link members ─────────────────────────────────
  let conceptsCreated   = 0;
  let itemsConsolidated = 0;

  for (const cluster of clusters) {
    const avgSalience    = cluster.reduce((s, e) => s + e.item.salience, 0) / cluster.length;
    const seedContent    = cluster[0].item.content;
    const conceptId      = `concept_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const conceptLabel   = `[CONCEPT] ${seedContent.slice(0, 60)}`;
    const conceptText    = cluster.map(e => e.item.content).join(' | ');

    // Add concept node to graph
    try {
      await rightBrain.addNode({ id: conceptId, label: conceptLabel, text: conceptText });

      // Link each member to the concept
      for (const { item } of cluster) {
        // member → concept  (high weight — this is what the concept is made of)
        rightBrain.addEdge({
          fromId:   item.id,
          toId:     conceptId,
          relation: 'part_of_concept',
          weight:   Math.min(1.0, item.salience + 0.2),
          salience: avgSalience,
        });

        workingMemory.markConsolidated({ id: item.id });
        itemsConsolidated++;
      }

      conceptsCreated++;
    } catch (err) {
      console.error('[consolidation] Failed to create concept node:', err.message);
    }
  }

  return {
    conceptsCreated,
    itemsConsolidated,
    clusters: clusters.map(c => ({
      size:         c.length,
      avgSalience:  (c.reduce((s, e) => s + e.item.salience, 0) / c.length).toFixed(2),
      seedContent:  c[0].item.content.slice(0, 80),
    })),
  };
}

module.exports = { runFor };
