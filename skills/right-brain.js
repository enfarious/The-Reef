'use strict';

// ─── Right Brain — Fuzzy Graph Memory ─────────────────────────────────────────
//
// Weighted directed graph stored in SQLite (better-sqlite3) with in-memory
// graphology graph for fast traversal.  Node embeddings via sentence-transformers
// for fuzzy entry-point matching.
//
// @xenova/transformers is ESM-only — loaded via dynamic import() inside init().
// graphology and better-sqlite3 have CJS exports and require() normally.
//
// All paths are injected via init(opts) — no hardcoded __dirname assumptions.
// The module holds a single lazy-initialised singleton instance.

const Database              = require('better-sqlite3');
const { DirectedGraph }     = require('graphology');

// Singleton instance — populated by init()
let instance = null;

// ─── Cosine similarity ────────────────────────────────────────────────────────

function cosine(a, b) {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot  += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

// ─── RightBrain class ─────────────────────────────────────────────────────────

class RightBrain {
  constructor(dbPath, cacheDir) {
    this.dbPath    = dbPath;
    this.cacheDir  = cacheDir;
    this.db        = null;
    this.graph     = new DirectedGraph();
    this.embedder  = null;
    this._embeddings = new Map(); // nodeId → Float32Array
    this._ready    = false;
  }

  async init() {
    // ── SQLite ────────────────────────────────────────────────────────────────
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
        id         TEXT PRIMARY KEY,
        label      TEXT NOT NULL,
        text       TEXT NOT NULL,
        embedding  TEXT NOT NULL,
        created_at INTEGER DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS edges (
        from_id         TEXT NOT NULL,
        to_id           TEXT NOT NULL,
        relation        TEXT NOT NULL,
        weight          REAL NOT NULL DEFAULT 0.5,
        salience        REAL NOT NULL DEFAULT 0.5,
        last_reinforced INTEGER DEFAULT (unixepoch()),
        created_at      INTEGER DEFAULT (unixepoch()),
        PRIMARY KEY (from_id, to_id, relation)
      );

      CREATE TABLE IF NOT EXISTS working_memory (
        id           TEXT PRIMARY KEY,
        persona_id   TEXT NOT NULL,
        content      TEXT NOT NULL,
        salience     REAL NOT NULL DEFAULT 0.5,
        appearances  INTEGER NOT NULL DEFAULT 1,
        high_sal     INTEGER NOT NULL DEFAULT 0,
        created_at   INTEGER DEFAULT (unixepoch()),
        expires_at   INTEGER NOT NULL,
        consolidated INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS wm_persona ON working_memory(persona_id, consolidated);
      CREATE INDEX IF NOT EXISTS wm_expires  ON working_memory(expires_at);
    `);

    // ── Embedder (lazy dynamic import for ESM-only package) ───────────────────
    if (this.cacheDir) {
      process.env.TRANSFORMERS_CACHE = this.cacheDir;
    }
    console.log('[right-brain] Loading embedding model...');
    const { pipeline } = await import('@xenova/transformers');
    this.embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
    console.log('[right-brain] Model ready.');

    // ── Rebuild in-memory graph from DB ───────────────────────────────────────
    for (const row of this.db.prepare('SELECT * FROM nodes').all()) {
      this.graph.addNode(row.id, { label: row.label, text: row.text });
      this._embeddings.set(row.id, new Float32Array(JSON.parse(row.embedding)));
    }
    for (const row of this.db.prepare('SELECT * FROM edges').all()) {
      if (this.graph.hasNode(row.from_id) && this.graph.hasNode(row.to_id)) {
        this.graph.addEdge(row.from_id, row.to_id, {
          relation: row.relation,
          weight:   row.weight,
          salience: row.salience,
        });
      }
    }

    this._ready = true;
    return this;
  }

  _assertReady() {
    if (!this._ready) throw new Error('right-brain not initialised — call init() first');
  }

  async _embed(text) {
    const out = await this.embedder(text, { pooling: 'mean', normalize: true });
    return Array.from(out.data);
  }

  // ─── Write ──────────────────────────────────────────────────────────────────

  async addNode(id, label, text) {
    this._assertReady();
    const embedding = await this._embed(text);
    this.db.prepare(`
      INSERT OR REPLACE INTO nodes (id, label, text, embedding)
      VALUES (?, ?, ?, ?)
    `).run(id, label, text, JSON.stringify(embedding));

    if (this.graph.hasNode(id)) {
      this.graph.setNodeAttribute(id, 'label', label);
      this.graph.setNodeAttribute(id, 'text', text);
    } else {
      this.graph.addNode(id, { label, text });
    }
    this._embeddings.set(id, new Float32Array(embedding));
    return id;
  }

  addEdge(fromId, toId, relation, weight = 0.5, salience = 0.5) {
    this._assertReady();
    if (!this.graph.hasNode(fromId)) throw new Error(`Node not found: ${fromId}`);
    if (!this.graph.hasNode(toId))   throw new Error(`Node not found: ${toId}`);

    this.db.prepare(`
      INSERT OR REPLACE INTO edges (from_id, to_id, relation, weight, salience)
      VALUES (?, ?, ?, ?, ?)
    `).run(fromId, toId, relation, weight, salience);

    const existing = this.graph.edges(fromId, toId)
      .find(e => this.graph.getEdgeAttribute(e, 'relation') === relation);
    if (existing) {
      this.graph.setEdgeAttribute(existing, 'weight', weight);
      this.graph.setEdgeAttribute(existing, 'salience', salience);
    } else {
      this.graph.addEdge(fromId, toId, { relation, weight, salience });
    }
  }

  // Increment edge weight without resetting last_reinforced
  reinforceEdge(fromId, toId, relation, delta = 0.1) {
    this._assertReady();
    const stmt = this.db.prepare(`
      UPDATE edges
      SET weight          = MIN(1.0, weight + ?),
          last_reinforced = unixepoch()
      WHERE from_id = ? AND to_id = ? AND relation = ?
    `);
    const result = stmt.run(delta, fromId, toId, relation);
    if (result.changes > 0) {
      const edge = this.graph.edges(fromId, toId)
        .find(e => this.graph.getEdgeAttribute(e, 'relation') === relation);
      if (edge) {
        const current = this.graph.getEdgeAttribute(edge, 'weight');
        this.graph.setEdgeAttribute(edge, 'weight', Math.min(1.0, current + delta));
      }
    }
    return result.changes > 0;
  }

  // Decay all edges; return pruned edges (weight < pruneThreshold) before deleting them
  decayEdges({ decayFactor = 0.95, pruneThreshold = 0.1 } = {}) {
    this._assertReady();

    // Salience-weighted decay in a single SQL pass
    this.db.prepare(`
      UPDATE edges
      SET weight = weight * CASE
        WHEN salience >= 0.8 THEN 0.99
        WHEN salience >= 0.6 THEN 0.98
        ELSE ?
      END
    `).run(decayFactor);

    // Collect edges to prune
    const pruned = this.db.prepare(`
      SELECT from_id, to_id, relation, weight, salience, created_at
      FROM edges WHERE weight < ?
    `).all(pruneThreshold);

    // Delete from SQLite
    const del = this.db.prepare(
      'DELETE FROM edges WHERE from_id = ? AND to_id = ? AND relation = ?'
    );
    const deleteMany = this.db.transaction((rows) => {
      for (const row of rows) del.run(row.from_id, row.to_id, row.relation);
    });
    deleteMany(pruned);

    // Sync in-memory graph
    for (const row of pruned) {
      const edgeKey = this.graph.edges(row.from_id, row.to_id)
        .find(e => this.graph.getEdgeAttribute(e, 'relation') === row.relation);
      if (edgeKey) this.graph.dropEdge(edgeKey);
    }

    return pruned.map(r => ({
      fromId:    r.from_id,
      toId:      r.to_id,
      relation:  r.relation,
      weight:    r.weight,
      salience:  r.salience,
      createdAt: r.created_at,
    }));
  }

  // ─── Read ───────────────────────────────────────────────────────────────────

  async fuzzySearch(query, topN = 3) {
    this._assertReady();
    const qEmb = new Float32Array(await this._embed(query));
    const scores = [];
    for (const [nodeId, emb] of this._embeddings) {
      scores.push({ nodeId, score: cosine(qEmb, emb) });
    }
    scores.sort((a, b) => b.score - a.score);
    return scores.slice(0, topN).map(({ nodeId, score }) => ({
      nodeId,
      score,
      label: this.graph.getNodeAttribute(nodeId, 'label'),
      text:  this.graph.getNodeAttribute(nodeId, 'text'),
    }));
  }

  traverse(anchorIds, hops = 2, minWeight = 0.4) {
    this._assertReady();
    const visited = new Set();
    const queue   = anchorIds
      .filter(id => this.graph.hasNode(id))
      .map(id => ({ id, depth: 0, path: [] }));
    const result  = [];

    while (queue.length > 0) {
      const { id, depth, path } = queue.shift();
      if (visited.has(id)) continue;
      visited.add(id);

      result.push({
        id,
        label: this.graph.getNodeAttribute(id, 'label'),
        depth,
        path,
      });

      if (depth >= hops) continue;

      for (const edge of this.graph.outEdges(id)) {
        const weight   = this.graph.getEdgeAttribute(edge, 'weight');
        const relation = this.graph.getEdgeAttribute(edge, 'relation');
        const target   = this.graph.target(edge);
        if (weight < minWeight || visited.has(target)) continue;
        queue.push({
          id:    target,
          depth: depth + 1,
          path:  [...path, { from: id, relation, weight: weight.toFixed(2), to: target }],
        });
      }
    }

    return result;
  }

  // Convenience: fuzzy search then traverse
  async recall(query, { topN = 3, hops = 2, minWeight = 0.4 } = {}) {
    this._assertReady();
    const anchors    = await this.fuzzySearch(query, topN);
    const anchorIds  = anchors.map(a => a.nodeId);
    const traversal  = this.traverse(anchorIds, hops, minWeight);
    return { anchors, traversal };
  }

  // Only adds the node if it doesn't already exist — avoids re-embedding on every broker.remember call
  async ensureNode(id, label, text) {
    this._assertReady();
    if (this.graph.hasNode(id)) return id;
    return this.addNode(id, label, text);
  }

  // Public embed — used by consolidation module
  async embed(text) {
    this._assertReady();
    return this._embed(text);
  }

  getStats() {
    this._assertReady();
    return {
      nodeCount: this.graph.order,
      edgeCount: this.graph.size,
      ready:     this._ready,
    };
  }

  close() {
    this.db?.close();
  }
}

// ─── Module-level singleton API ───────────────────────────────────────────────

async function init({ dbPath, cacheDir } = {}) {
  if (!dbPath) throw new Error('right-brain init: dbPath is required');
  instance = new RightBrain(dbPath, cacheDir);
  await instance.init();
}

function _get() {
  if (!instance) throw new Error('right-brain not initialised');
  return instance;
}

// Exposes the SQLite db handle to sibling modules (working-memory.js).
// Only available after init().
function getDb() {
  return _get().db;
}

// Skill handler wrappers — each receives an args object from the IPC layer
async function addNode({ id, label, text })                              { return _get().addNode(id, label, text); }
async function ensureNode({ id, label, text })                           { return _get().ensureNode(id, label, text); }
function  addEdge({ fromId, toId, relation, weight, salience })          { return _get().addEdge(fromId, toId, relation, weight, salience); }
function  reinforceEdge({ fromId, toId, relation, delta })               { return _get().reinforceEdge(fromId, toId, relation, delta); }
function  decayEdges({ decayFactor, pruneThreshold } = {})              { return _get().decayEdges({ decayFactor, pruneThreshold }); }
async function fuzzySearch({ query, topN })                              { return _get().fuzzySearch(query, topN); }
function  traverse({ anchorIds, hops, minWeight })                       { return _get().traverse(anchorIds, hops, minWeight); }
async function recall({ query, topN, hops, minWeight } = {})            { return _get().recall(query, { topN, hops, minWeight }); }
async function embed({ text })                                           { return _get().embed(text); }
function  getStats()                                                     { return _get().getStats(); }

module.exports = {
  init,
  getDb,
  addNode,
  ensureNode,
  addEdge,
  reinforceEdge,
  decayEdges,
  fuzzySearch,
  traverse,
  recall,
  embed,
  getStats,
};
