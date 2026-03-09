'use strict';

// ─── Broker (Cortex) — Memory Coordination Layer ──────────────────────────────
//
// The single point of contact for all v3 memory operations.
// No instance reads or writes long-term memory directly — everything routes here.
//
// On write: classify content → route to left brain, right brain, or both.
// On read:  parallel left+right retrieval → merge anchors → assemble context.
//
// Phase 2 coexistence: memory.* and broker.* both work. Neither replaces the other yet.
// Phase 5 will add decay pass delegation.

const leftBrain   = require('./left-brain');
const rightBrain  = require('./right-brain');
const trust       = require('./trust');
const salience    = require('./salience');
const arbitration = require('./arbitration');

// ─── Content classification ───────────────────────────────────────────────────
// Heuristic keyword routing. In practice most content routes to both brains.

const RELATIONAL_VERBS = [
  'builds', 'building', 'uses', 'using', 'blocks', 'blocking', 'needs',
  'requires', 'frustrates', 'frustrating', 'excited', 'excited_by',
  'part_of', 'powers', 'causes', 'caused_by', 'leads_to', 'depends_on',
  'consists_of', 'belongs_to', 'owns', 'manages', 'reports_to',
];

function classify(content, sourceId = null) {
  const lower    = content.toLowerCase();
  const sal      = salience.assess(content, sourceId);
  const toLeft   = true; // always write facts
  const toRight  = RELATIONAL_VERBS.some(v => lower.includes(v))
                || lower.includes(' is ') || lower.includes(' are ')
                || sal.level === 'high' || sal.level === 'critical';
  return { toLeft, toRight, sal };
}

// ─── Node ID helper ───────────────────────────────────────────────────────────
// Converts an entity name to a stable graph node ID.

function toNodeId(name) {
  return String(name).toLowerCase().replace(/[\s\W]+/g, '_').replace(/^_|_$/g, '');
}

// ─── remember ─────────────────────────────────────────────────────────────────
// Write a subject → relation → object triple to both brains.
// args: { subject, relation, object, sourceId, salience? }

async function remember({ subject, relation, object, sourceId = 'system', salience: explicitSalience } = {}) {
  if (!subject)  throw new Error('broker.remember: subject is required');
  if (!relation) throw new Error('broker.remember: relation is required');
  if (!object)   throw new Error('broker.remember: object is required');

  const content    = `${subject} ${relation} ${object}`;
  const cls        = classify(content, sourceId);
  const sal        = explicitSalience != null ? { score: explicitSalience, level: explicitSalience >= 0.8 ? 'high' : 'normal', highSalience: explicitSalience >= 0.65 } : cls.sal;
  const trustVal   = trust.getWeight(sourceId);
  const edgeWeight = salience.baseWeight(sal.level);

  const results = {};

  // ── Left brain ──────────────────────────────────────────────────────────────
  if (cls.toLeft) {
    try {
      const { action } = await arbitration.check(subject, relation, object, sourceId);
      if (action !== 'reject') {
        await leftBrain.setFact(subject, relation, object, sourceId, trustVal);
      }
      await leftBrain.recordEpisode(content, [subject, object], sourceId, sal.score);
      results.leftBrain = { action };
    } catch (err) {
      results.leftBrain = { error: err.message };
    }
  }

  // ── Right brain ─────────────────────────────────────────────────────────────
  if (cls.toRight) {
    try {
      const fromId = toNodeId(subject);
      const toId   = toNodeId(object);
      await rightBrain.ensureNode({ id: fromId, label: subject, text: subject });
      await rightBrain.ensureNode({ id: toId,   label: object,  text: object  });
      rightBrain.addEdge({ fromId, toId, relation, weight: edgeWeight, salience: sal.score });
      results.rightBrain = { action: 'edge_written', fromId, toId, relation };
    } catch (err) {
      results.rightBrain = { error: err.message };
    }
  }

  return { subject, relation, object, sourceId, salience: sal.score, level: sal.level, results };
}

// ─── recall ───────────────────────────────────────────────────────────────────
// Hybrid retrieval: parallel left+right, merge anchors, assemble context.
// args: { query, primingSignal?, tokenBudget? }
// primingSignal: { type: 'technical' | 'reflective' | 'general', focus?: string[] }

async function recall({ query, primingSignal = {}, tokenBudget = 1500 } = {}) {
  if (!query) throw new Error('broker.recall: query is required');

  const results = { leftBrainFacts: [], traversal: [], anchors: [], assembled: '' };

  // ── Parallel retrieval ──────────────────────────────────────────────────────
  const [episodes, graphResult] = await Promise.allSettled([
    leftBrain.getRecentHighSalience(5),
    rightBrain.recall({ query, topN: 4, hops: 2, minWeight: 0.35 }).catch(err => {
      console.warn('[broker] right-brain recall failed:', err.message);
      return { anchors: [], traversal: [] };
    }),
  ]);

  if (episodes.status === 'fulfilled') {
    results.leftBrainFacts = episodes.value;
  }

  if (graphResult.status === 'fulfilled') {
    results.anchors  = graphResult.value.anchors;
    results.traversal = graphResult.value.traversal;
  }

  // ── Assemble context within token budget ────────────────────────────────────
  // Rough token estimate: 1 token ≈ 4 chars. Stay under tokenBudget * 4 chars.
  const charBudget = tokenBudget * 4;
  const sections = [];

  if (results.leftBrainFacts.length) {
    const episodeBlock = results.leftBrainFacts
      .map(e => `[${e.source_id} · sal:${e.salience.toFixed(1)}] ${e.content}`)
      .join('\n');
    sections.push(`=== RECENT EPISODES ===\n${episodeBlock}`);
  }

  if (results.traversal.length) {
    const graphBlock = results.traversal.map(node => {
      const indent = '  '.repeat(node.depth);
      const edge   = node.path.at(-1);
      const via    = edge ? ` ← ${edge.relation} (${edge.weight}) from ${edge.from}` : ' [anchor]';
      return `${indent}• ${node.label}${via}`;
    }).join('\n');
    sections.push(`=== GRAPH CONTEXT ===\n${graphBlock}`);
  }

  let assembled = sections.join('\n\n');
  if (assembled.length > charBudget) {
    assembled = assembled.slice(0, charBudget) + '\n[...truncated]';
  }
  results.assembled = assembled;

  return results;
}

// ─── Seed default sources ─────────────────────────────────────────────────────
// Called from main.js after db.init() to register the three colony personas.

async function seedSources() {
  try {
    await Promise.all([
      leftBrain.registerSource('mike',      'Mike',      'operator', 1.0),
      leftBrain.registerSource('dreamer',   'Dreamer',   'persona',  0.7),
      leftBrain.registerSource('builder',   'Builder',   'persona',  0.7),
      leftBrain.registerSource('librarian', 'Librarian', 'persona',  0.7),
    ]);
  } catch (err) {
    console.error('[broker] seedSources failed:', err.message);
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  remember,
  recall,
  classify,
  seedSources,
  // expose sub-modules so main.js can call trust.load() without a separate require
  trust,
  salience,
  arbitration,
};
