'use strict';

// ─── Salience — Cognitive Weight Assessment ────────────────────────────────────
//
// Salience determines how strongly a memory item is weighted and how slowly
// it decays.  Assessed from content keywords plus per-instance profiles.
//
// Levels:
//   critical  score 0.9   decayMultiplier 0.25x  baseEdgeWeight 0.9
//   high      score 0.7   decayMultiplier 0.50x  baseEdgeWeight 0.7
//   normal    score 0.5   decayMultiplier 1.00x  baseEdgeWeight 0.5
//   low       score 0.2   decayMultiplier 1.50x  baseEdgeWeight 0.3

// ─── Keyword lists ────────────────────────────────────────────────────────────

const CRITICAL_KEYWORDS = [
  'critical', 'urgent', 'emergency', 'breaking', 'catastrophic', 'down',
];

const HIGH_KEYWORDS = [
  'breakthrough', 'blocked', 'finally', 'frustrated', 'excited', 'important',
  'stuck', 'solved', 'broken', 'deployed', 'shipped', 'failed', 'discovered',
  'realized', 'bug', 'error', 'crash', 'fixed', 'key insight', 'milestone',
  'can\'t', 'cannot',
];

const LOW_PATTERNS = [
  /^(ok|okay|yes|no|sure|thanks|noted|got it|acknowledged)\.?$/i,
  /^checking/i,
  /^looking at/i,
  /^will do/i,
  /^\s*$/,
];

// ─── Per-instance salience profiles ───────────────────────────────────────────
// Each instance up-weights content relevant to its domain.
// These are additive boosts applied on top of the base keyword scan.

const INSTANCE_PROFILES = {
  librarian: {
    boost: ['memory', 'pattern', 'connection', 'link', 'cluster', 'archive',
             'consolidate', 'recurring', 'theme', 'fragment', 'graph'],
    score: 0.1,
  },
  dreamer: {
    boost: ['vision', 'idea', 'concept', 'imagine', 'creative', 'potential',
             'what if', 'could be', 'dream', 'inspiration'],
    score: 0.1,
  },
  builder: {
    boost: ['blocker', 'shipped', 'deployed', 'built', 'fixed', 'broke',
             'dependency', 'version', 'build', 'test', 'implementation'],
    score: 0.1,
  },
};

// ─── assess ───────────────────────────────────────────────────────────────────
// Evaluate salience of a content string, optionally tuned to a source's profile.
// Returns: { level, score, decayMultiplier, highSalience }

function assess(content, sourceId = null) {
  const lower = String(content).toLowerCase();

  // Check low patterns first (quick exit for filler)
  if (LOW_PATTERNS.some(p => p.test(lower))) {
    return { level: 'low', score: 0.2, decayMultiplier: 1.5, highSalience: false };
  }

  let score = 0.5; // baseline

  // Critical keywords — strongest signal
  if (CRITICAL_KEYWORDS.some(w => lower.includes(w))) {
    score = Math.max(score, 0.9);
  }

  // High-salience keywords
  const highMatches = HIGH_KEYWORDS.filter(w => lower.includes(w)).length;
  if (highMatches >= 3) {
    score = Math.max(score, 0.85); // multiple hits → very high
  } else if (highMatches >= 1) {
    score = Math.max(score, 0.7);
  }

  // Per-instance profile boost
  if (sourceId) {
    const profile = INSTANCE_PROFILES[String(sourceId).toLowerCase()];
    if (profile && profile.boost.some(w => lower.includes(w))) {
      score = Math.min(1.0, score + profile.score);
    }
  }

  // Map score to level + decay
  if (score >= 0.85) return { level: 'critical', score, decayMultiplier: 0.25, highSalience: true };
  if (score >= 0.65) return { level: 'high',     score, decayMultiplier: 0.50, highSalience: true };
  if (score >= 0.45) return { level: 'normal',   score, decayMultiplier: 1.00, highSalience: false };
  return               { level: 'low',     score, decayMultiplier: 1.50, highSalience: false };
}

// ─── Derived helpers ──────────────────────────────────────────────────────────

// Base edge weight for the relationship graph by salience level.
function baseWeight(level) {
  return { critical: 0.9, high: 0.7, normal: 0.5, low: 0.3 }[level] ?? 0.5;
}

// Decay multiplier by level — passed to the decay scheduler per-edge.
function decayMultiplier(level) {
  return { critical: 0.25, high: 0.5, normal: 1.0, low: 1.5 }[level] ?? 1.0;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  assess,
  baseWeight,
  decayMultiplier,
  INSTANCE_PROFILES,
};
