'use strict';

// ─── Arbitration — Contradiction Resolution ────────────────────────────────────
//
// When two sources disagree on a fact, the broker does not silently overwrite.
// Arbitration classifies the conflict and decides: accept, defer, or reject.
//
// Three outcomes (determined by trust gap):
//   accept   — new trust is comparable or better (gap < 0.2); fact is revised
//   defer    — trust gap is within 0.2; both versions stored, contradiction flagged
//   reject   — old source significantly more trusted (gap > 0.2); new value ignored
//
// runAutoResolve() is the Librarian's maintenance tool: it resolves all pending
// contradictions where the trust gap is unambiguous, and returns the remainder
// for human or LLM review.

const leftBrain = require('./left-brain');
const trust     = require('./trust');

const TRUST_GAP_THRESHOLD = 0.2;

// ─── check ───────────────────────────────────────────────────────────────────
// Called by broker.remember before writing a new fact.
// Returns: { action: 'accept'|'defer'|'reject', existingAttrId: number|null }

async function check(entityName, key, newValue, sourceId) {
  const { contradicts, existing } = await leftBrain.checkContradiction(entityName, key, newValue);

  if (!contradicts || !existing) {
    return { action: 'accept', existingAttrId: null };
  }

  const newTrust = trust.getWeight(sourceId);
  const oldTrust = existing.trust_weight;
  const gap      = newTrust - oldTrust;

  if (gap > TRUST_GAP_THRESHOLD) {
    // New source is significantly more trusted — accept and revise
    return { action: 'accept', existingAttrId: existing.id };
  }

  if (gap < -TRUST_GAP_THRESHOLD) {
    // Old source is significantly more trusted — reject new value
    await leftBrain.flagContradiction(existing.id, newValue, sourceId);
    return { action: 'reject', existingAttrId: existing.id };
  }

  // Trust gap is within threshold — defer (store both, flag)
  await leftBrain.flagContradiction(existing.id, newValue, sourceId);
  return { action: 'defer', existingAttrId: existing.id };
}

// ─── listPending ─────────────────────────────────────────────────────────────
// Returns all unresolved contradictions with context.

async function listPending() {
  return leftBrain.listPendingContradictions();
}

// ─── resolve ─────────────────────────────────────────────────────────────────
// Manually mark a contradiction as resolved.

async function resolve(contradictionId) {
  await leftBrain.resolveContradiction(contradictionId);
  return { resolved: contradictionId };
}

// ─── runAutoResolve ──────────────────────────────────────────────────────────
// Auto-resolves pending contradictions where the trust gap is unambiguous (> 0.2).
// Returns { resolved: [...], deferred: [...] } for the Librarian to report on.

async function runAutoResolve() {
  const pending  = await listPending();
  const resolved = [];
  const deferred = [];

  for (const row of pending) {
    // We need to compare the stored attribute's trust weight against any source
    // that might have a higher trust level — but we only have source IDs here.
    // Use the trust module to find the weight of the source that flagged the contradiction.
    const newTrust = trust.getWeight(row.source_id);
    const oldTrust = row.trust_weight; // trust_weight of the existing lb_attribute

    const gap = newTrust - oldTrust;

    if (Math.abs(gap) > TRUST_GAP_THRESHOLD) {
      // Clear winner — auto-resolve
      await resolve(row.id);
      resolved.push({
        id:          row.id,
        entity:      row.entity_name,
        key:         row.key,
        winner:      gap > 0 ? row.new_value : row.existing_value,
        sourceId:    row.source_id,
        gap:         gap.toFixed(2),
      });
    } else {
      // Ambiguous — leave for Librarian review
      deferred.push({
        id:            row.id,
        entity:        row.entity_name,
        key:           row.key,
        existingValue: row.existing_value,
        newValue:      row.new_value,
        sourceId:      row.source_id,
        flaggedAt:     row.flagged_at,
      });
    }
  }

  return {
    resolved,
    deferred,
    note: deferred.length
      ? `${deferred.length} contradiction(s) require Librarian review.`
      : 'All contradictions resolved automatically.',
  };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  check,
  listPending,
  resolve,
  runAutoResolve,
};
