'use strict';

// ─── Decay Scheduler — Automated Graph Maintenance ────────────────────────────
//
// Runs the right-brain decay pass on a configurable interval (default 6 hours).
// Uses self-rescheduling setTimeout — the next run only begins after the current
// one completes.  Prevents accumulation of stale ticks during a slow pass.
//
// Each pass:
//   1. rightBrain.decayEdges() — salience-weighted weight reduction
//   2. coldStorage.archive()   — archive edges below prune threshold
//   3. workingMemory.sweep()   — clear expired + consolidated WM items
//
// Also exposed as a skill (graph.runDecayPass) so the Librarian can trigger a
// manual pass during its Sleeper cycle without waiting for the timer.

const rightBrain    = require('./right-brain');
const coldStorage   = require('./cold-storage');
const workingMemory = require('./working-memory');

const DEFAULT_INTERVAL_MS    = 6 * 60 * 60 * 1000;  // 6 hours
const DEFAULT_PRUNE_THRESHOLD = 0.1;

let _timer         = null;
let _intervalMs    = DEFAULT_INTERVAL_MS;
let _pruneThreshold = DEFAULT_PRUNE_THRESHOLD;
let _running       = false;
let _lastRun       = null;

// ─── runPass ─────────────────────────────────────────────────────────────────
// Execute one full maintenance pass.
// Returns: { edgesDecayed, edgesPruned, archived, wmSwept, durationMs }
// args: { pruneThreshold? } — overrides the scheduler default for this run only

async function runPass({ pruneThreshold } = {}) {
  const threshold = pruneThreshold ?? _pruneThreshold;
  const start     = Date.now();

  const result = {
    edgesDecayed: 0,
    edgesPruned:  0,
    archived:     0,
    wmSwept:      0,
    durationMs:   0,
    errors:       [],
  };

  // ── 1. Decay + prune graph edges ────────────────────────────────────────────
  try {
    const pruned = rightBrain.decayEdges({ pruneThreshold: threshold });
    result.edgesPruned  = pruned.length;
    result.edgesDecayed = rightBrain.getStats().edgeCount; // remaining after prune

    // ── 2. Archive pruned edges to cold storage ────────────────────────────────
    if (pruned.length > 0) {
      result.archived = await coldStorage.archive(pruned);
    }
  } catch (err) {
    // right-brain may not be ready — non-fatal
    result.errors.push(`decay: ${err.message}`);
  }

  // ── 3. Sweep expired working memory ─────────────────────────────────────────
  try {
    const swept = workingMemory.sweep();
    result.wmSwept = swept.expired;
  } catch (err) {
    result.errors.push(`wm_sweep: ${err.message}`);
  }

  result.durationMs = Date.now() - start;
  _lastRun = new Date().toISOString();

  if (result.errors.length) {
    console.warn('[decay] Pass completed with errors:', result.errors.join('; '));
  } else {
    console.log(
      `[decay] Pass done — pruned:${result.edgesPruned} archived:${result.archived} wmSwept:${result.wmSwept} (${result.durationMs}ms)`
    );
  }

  return result;
}

// ─── start ───────────────────────────────────────────────────────────────────
// Begin the self-rescheduling decay loop.
// Safe to call multiple times — only one loop runs at a time.

function start({ intervalMs = DEFAULT_INTERVAL_MS, pruneThreshold = DEFAULT_PRUNE_THRESHOLD } = {}) {
  if (_timer) return; // already running

  _intervalMs     = intervalMs;
  _pruneThreshold = pruneThreshold;

  function schedule() {
    _timer = setTimeout(async () => {
      _timer   = null;
      _running = true;
      try {
        await runPass();
      } finally {
        _running = false;
        if (_intervalMs > 0) schedule(); // reschedule only if not stopped
      }
    }, _intervalMs);
  }

  schedule();
  console.log(`[decay] Scheduler started — interval ${_intervalMs / 1000 / 60}min, prune threshold ${_pruneThreshold}`);
}

// ─── stop ────────────────────────────────────────────────────────────────────

function stop() {
  if (_timer) {
    clearTimeout(_timer);
    _timer = null;
  }
  _intervalMs = 0; // signal to the running pass not to reschedule
  console.log('[decay] Scheduler stopped.');
}

// ─── status ──────────────────────────────────────────────────────────────────

function status() {
  return {
    running:        _running,
    scheduled:      _timer !== null,
    intervalMs:     _intervalMs,
    pruneThreshold: _pruneThreshold,
    lastRun:        _lastRun,
  };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = { start, stop, runPass, status };
