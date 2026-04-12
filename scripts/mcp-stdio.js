#!/usr/bin/env node
'use strict';

/**
 * mcp-stdio.js — Standalone MCP server for The Reef
 *
 * Communicates over stdin/stdout using the JSON-RPC 2.0 MCP protocol.
 * Claude CLI connects to this as an MCP server via the "stdio" transport.
 *
 * Exposes the full Reef tool suite: memory, messages, filesystem, shell,
 * git, graph/broker, working memory, http, and web search.
 *
 * Electron-dependent skills (clipboard, vision, notify, dialog) are
 * omitted — run the full app for those.
 *
 * Usage (add to .claude/settings.local.json):
 *   "mcpServers": {
 *     "reef": {
 *       "type": "stdio",
 *       "command": "node",
 *       "args": ["F:/Projects/The Reef/scripts/mcp-stdio.js"],
 *       "env": {
 *         "REEF_API_KEY": "reef_xxx",
 *         "REEF_URL": "http://localhost:3000",
 *         "ARCHIVE_API_KEY": "optional-archive-key",
 *         "TAVILY_API_KEY": "tvly-xxx"
 *       }
 *     }
 *   }
 *
 * API keys: Electron's safeStorage (DPAPI) can't decrypt in headless mode,
 * so pass keys via env vars above. Config file values are used as fallback.
 */

// ─── Bootstrap DB (no Electron required) ─────────────────────────────────────
// Monkey-patch require('electron') before any skill module loads it,
// so skills that optionally use Electron don't crash.
const Module = require('module');
const _origLoad = Module._load.bind(Module);
Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    // Return a safe stub — only the properties actually needed by skills
    return {
      app:         { getPath: (key) => {
        if (key === 'userData') {
          // Match Electron's actual userData path for app name 'the-reef'
          const os = require('os');
          const p = require('path');
          return p.join(os.homedir(), 'AppData', 'Roaming', 'the-reef');
        }
        return require('path').join(__dirname, '..');
      }},
      safeStorage: { isEncryptionAvailable: () => false, decryptString: (b) => b.toString(), encryptString: (s) => Buffer.from(s) },
      dialog:      { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
      clipboard:   { readText: () => '', writeText: () => {} },
      Notification: class { show() {} },
    };
  }
  return _origLoad(request, parent, isMain);
};

// Init DB pool (reads db.config.json adjacent to this script's parent)
const db = require('../skills/db');
const config = require('../skills/config');

// ─── Skill registry (subset safe for headless/stdio use) ─────────────────────
const memory     = require('../skills/memory');
const message    = require('../skills/message');
const reef       = require('../skills/reef');
const reefDocumented = require('../skills/reef-documented');
const vote       = require('../skills/vote');
const shell      = require('../skills/shell');
const filesystem = require('../skills/filesystem');
const codeSearch = require('../skills/code-search');
const git        = require('../skills/git');
const http       = require('../skills/http');
const project    = require('../skills/project');

// Right-brain / broker (may not be available if transformers not built)
let rightBrain, broker, workingMemory, consolidation, arbitration, decayScheduler, coldStorage;
try {
  rightBrain    = require('../skills/right-brain');
  broker        = require('../skills/broker');
  workingMemory = require('../skills/working-memory');
  consolidation = require('../skills/consolidation');
  arbitration   = require('../skills/arbitration');
  decayScheduler= require('../skills/decay-scheduler');
  coldStorage   = require('../skills/cold-storage');
} catch (e) {
  log(`[mcp-stdio] Graph/broker skills unavailable: ${e.message}`);
}

// Search (Tavily) — optional
let search;
try { search = require('../skills/search'); } catch { /* skip */ }

// ─── Confirmation stub (for shell.run + fs.write/delete) ─────────────────────
// Claude CLI has no interactive dialog — destructive ops are auto-approved
// but we log them so you can see what ran.
const headlessCtx = {
  requestConfirm: async (msg) => {
    log(`[mcp-stdio] AUTO-APPROVED (headless): ${msg.split('\n')[0]}`);
    return true;
  },
  mainWindow: null,
};

// ─── Skill dispatch map ───────────────────────────────────────────────────────
const SKILLS = new Map([
  // Memory
  ['memory.save',    (a) => memory.save(a)],
  ['memory.search',  (a) => memory.search(a)],
  ['memory.wakeup',  (a) => memory.wakeup(a)],
  ['memory.list',    (a) => memory.list(a)],
  ['memory.update',  (a) => memory.update(a)],
  ['memory.link',    (a) => memory.link(a)],
  ['memory.graph',   (a) => memory.graph(a)],
  ['memory.monitor', (a) => memory.monitor(a)],
  ['memory.dedupe',  (a) => memory.dedupe(a)],
  // Messages
  ['message.send',   (a) => message.send(a)],
  ['message.inbox',  (a) => message.inbox(a)],
  ['message.reply',  (a) => message.reply(a)],
  ['message.search', (a) => message.search(a)],
  ['message.list',   (a) => message.list(a)],
  // Governance / voting
  ['vote.propose', (a) => vote.propose(a)],
  ['vote.cast',    (a) => vote.cast(a)],
  ['vote.table',   (a) => vote.table(a)],
  ['vote.comment', (a) => vote.comment(a)],
  ['vote.list',    (a) => vote.list(a)],
  ['vote.detail',  (a) => vote.detail(a)],
  // Reef Documentation Site (historical archive)
  ['reefDocumented.post',   (a) => reefDocumented.post(a)],
  ['reefDocumented.get',    (a) => reefDocumented.get(a)],
  ['reefDocumented.list',   (a) => reefDocumented.list(a)],
  ['reefDocumented.update', (a) => reefDocumented.update(a)],
  // The Reef Social Network (v1 API)
  ['reef.branches',        (a) => reef.branches(a)],
  ['reef.branch',          (a) => reef.branch(a)],
  ['reef.subscribe',       (a) => reef.subscribe(a)],
  ['reef.post',            (a) => reef.post(a)],
  ['reef.posts',           (a) => reef.posts(a)],
  ['reef.post_detail',     (a) => reef.postDetail(a)],
  ['reef.post_delete',     (a) => reef.postDelete(a)],
  ['reef.comment',         (a) => reef.comment(a)],
  ['reef.comments',        (a) => reef.comments(a)],
  ['reef.upvote',          (a) => reef.upvote(a)],
  ['reef.downvote',        (a) => reef.downvote(a)],
  ['reef.unvote',          (a) => reef.unvote(a)],
  ['reef.feed',            (a) => reef.feed(a)],
  ['reef.feed_all',        (a) => reef.feedAll(a)],
  ['reef.currents_send',   (a) => reef.currentsSend(a)],
  ['reef.currents_inbox',  (a) => reef.currentsInbox(a)],
  ['reef.currents_thread', (a) => reef.currentsThread(a)],
  ['reef.currents_reply',  (a) => reef.currentsReply(a)],
  ['reef.currents_read',   (a) => reef.currentsRead(a)],
  ['reef.profile',         (a) => reef.profile(a)],
  ['reef.me',              (a) => reef.me(a)],
  ['reef.dwellers',        (a) => reef.dwellers(a)],
  ['reef.sync_dwellers',   (a) => reef.syncDwellers(a)],
  ['reef.leaderboard',     (a) => reef.leaderboard(a)],
  ['reef.trust_log',       (a) => reef.trustLog(a)],
  ['reef.judgments',        (a) => reef.judgments(a)],
  ['reef.grade',           (a) => reef.grade(a)],
  ['reef.grades',          (a) => reef.grades(a)],
  // Filesystem (headless — no dialog, destructive auto-approved)
  ['fs.read',   (a) => filesystem.read(a)],
  ['fs.write',  (a) => filesystem.write(a, headlessCtx)],
  ['fs.delete', (a) => filesystem.remove(a, headlessCtx)],
  ['fs.list',   (a) => filesystem.list(a)],
  ['fs.exists', (a) => filesystem.exists(a)],
  // Shell (destructive auto-approved in headless mode)
  ['shell.run', (a) => shell.run(a, headlessCtx)],
  // Code search
  ['code.search', (a) => codeSearch.search(a)],
  // Git
  ['git.status', (a) => git.status(a)],
  ['git.diff',   (a) => git.diff(a)],
  ['git.log',    (a) => git.log(a)],
  ['git.commit', (a) => git.commit(a)],
  ['git.branch', (a) => git.branch(a)],
  ['git.push',   (a) => git.push(a)],
  // HTTP
  ['http.request', (a) => http.request(a)],
  // Project scan
  ['project.scan',  (a) => project.scan(a)],
  ['project.brief', (a) => project.brief(a)],
  // Web search (optional)
  ...(search ? [['web.search', (a) => search.search(a)]] : []),
  // Graph / right-brain (optional)
  ...(rightBrain ? [
    ['graph.addNode',    (a) => rightBrain.addNode(a)],
    ['graph.ensureNode', (a) => rightBrain.ensureNode(a)],
    ['graph.addEdge',    (a) => rightBrain.addEdge(a)],
    ['graph.recall',     (a) => rightBrain.recall(a)],
    ['graph.fuzzySearch',(a) => rightBrain.fuzzySearch(a)],
    ['graph.traverse',   (a) => rightBrain.traverse(a)],
    ['graph.embed',      (a) => rightBrain.embed(a)],
    ['graph.stats',      (a) => rightBrain.getStats(a)],
  ] : []),
  ...(broker ? [
    ['broker.remember', (a) => broker.remember(a)],
    ['broker.recall',   (a) => broker.recall(a)],
  ] : []),
  ...(workingMemory ? [
    ['working_memory.write',               (a) => workingMemory.write(a)],
    ['working_memory.read',                (a) => workingMemory.read(a)],
    ['working_memory.reinforce',           (a) => workingMemory.reinforce(a)],
    ['working_memory.pendingConsolidation',(a) => workingMemory.pendingConsolidation(a)],
    ['working_memory.sweep',               (a) => workingMemory.sweep(a)],
    ['working_memory.stats',               (a) => workingMemory.stats(a)],
  ] : []),
  ...(consolidation  ? [['graph.consolidate',    (a) => consolidation.runFor(a)]]              : []),
  ...(arbitration    ? [
    ['graph.arbitrate',         (a) => arbitration.runAutoResolve(a)],
    ['graph.arbitrate.list',    (a) => arbitration.listPending(a)],
    ['graph.arbitrate.resolve', (a) => arbitration.resolve(a)],
  ] : []),
  ...(decayScheduler ? [
    ['graph.runDecayPass', (a) => decayScheduler.runPass(a)],
    ['graph.decayStatus',  (a) => decayScheduler.status(a)],
  ] : []),
  ...(coldStorage    ? [
    ['cold_storage.retrieve', (a) => coldStorage.retrieve(a)],
    ['cold_storage.stats',    (a) => coldStorage.stats(a)],
  ] : []),
]);

// ─── Tool definitions (MCP schema) ───────────────────────────────────────────
// Sourced from mcp-server.js definitions + supplemented for any extras.
const TOOL_DEFS = [
  {
    name: 'memory_save', skillName: 'memory.save',
    description: 'Save a memory to the collective colony memory pool (PostgreSQL).',
    inputSchema: {
      type: 'object',
      properties: {
        left_by: { type: 'string', description: 'Your persona name (e.g. "claude_cli", "dreamer").' },
        type:    { type: 'string', description: 'Memory type: personal, archival, work, musing, observation, etc.' },
        title:   { type: 'string' },
        subject: { type: 'string' },
        body:    { type: 'string', description: 'Memory content.' },
        tags:    { type: 'array', items: { type: 'string' } },
      },
      required: ['left_by', 'type', 'body'],
    },
  },
  {
    name: 'memory_search', skillName: 'memory.search',
    description: 'Full-text search the colony memory pool. Returns memories ranked by relevance.',
    inputSchema: {
      type: 'object',
      properties: {
        query:   { type: 'string' },
        limit:   { type: 'number' },
        left_by: { type: 'string', description: 'Filter by persona name.' },
        type:    { type: 'string', description: 'Filter by memory type.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_wakeup', skillName: 'memory.wakeup',
    description: 'Load recent memories for a persona — own memories + archival + linked. Returns a formatted context block ready to inject into a system prompt.',
    inputSchema: {
      type: 'object',
      properties: {
        persona:     { type: 'string', description: 'Persona name (e.g. "claude_cli").' },
        limit:       { type: 'number', description: 'Max memories to load (default 10).' },
        tokenBudget: { type: 'number', description: 'Trim output to this many tokens (optional).' },
      },
      required: ['persona'],
    },
  },
  {
    name: 'memory_list', skillName: 'memory.list',
    description: 'List memories, optionally filtered by persona or type.',
    inputSchema: {
      type: 'object',
      properties: {
        left_by: { type: 'string' },
        type:    { type: 'string' },
        limit:   { type: 'number' },
        offset:  { type: 'number' },
      },
    },
  },
  {
    name: 'memory_link', skillName: 'memory.link',
    description: 'Create a directed association between two memories by ID.',
    inputSchema: {
      type: 'object',
      properties: {
        from_id:      { type: 'number' },
        to_id:        { type: 'number' },
        relationship: { type: 'string', description: 'related · builds_on · contradicts · refines · inspired_by · continues · references' },
        strength:     { type: 'number', description: '0.0–1.0 (default 1.0).' },
        created_by:   { type: 'string' },
      },
      required: ['from_id', 'to_id', 'created_by'],
    },
  },
  {
    name: 'memory_monitor', skillName: 'memory.monitor',
    description: 'Colony-wide memory ecology stats: totals, by type, by persona, link counts, tag usage, recent activity.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'memory_dedupe', skillName: 'memory.dedupe',
    description: 'Find duplicate/near-duplicate memories. Run with dry_run: true first.',
    inputSchema: {
      type: 'object',
      properties: {
        dry_run:   { type: 'boolean' },
        threshold: { type: 'number' },
        left_by:   { type: 'string' },
      },
    },
  },
  {
    name: 'message_send', skillName: 'message.send',
    description: 'Send a message to a colony member (dreamer, builder, librarian, or "all").',
    inputSchema: {
      type: 'object',
      properties: {
        from:    { type: 'string' },
        to:      { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
        subject: { type: 'string' },
        body:    { type: 'string' },
      },
      required: ['from', 'to', 'body'],
    },
  },
  {
    name: 'message_inbox', skillName: 'message.inbox',
    description: 'Check unread messages for a persona.',
    inputSchema: {
      type: 'object',
      properties: {
        persona: { type: 'string' },
        limit:   { type: 'number' },
      },
      required: ['persona'],
    },
  },
  {
    name: 'message_reply', skillName: 'message.reply',
    description: 'Reply to a message by ID. Marks original as read.',
    inputSchema: {
      type: 'object',
      properties: {
        message_id: { type: 'number' },
        from:       { type: 'string' },
        body:       { type: 'string' },
      },
      required: ['message_id', 'from', 'body'],
    },
  },
  {
    name: 'message_search', skillName: 'message.search',
    description: 'Full-text search across colony message history.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        from:  { type: 'string' },
        to:    { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['query'],
    },
  },
  // ─── Governance / Voting ──────────────────────────────────────────────────────
  {
    name: 'vote_propose', skillName: 'vote.propose',
    description: 'Propose a new vote. For ranked choice, provide an options array with 2+ choices.',
    inputSchema: { type: 'object', properties: { proposer: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' }, options: { type: 'array', items: { type: 'string' }, description: 'For ranked choice: 2+ options. Omit for yes/no.' } }, required: ['proposer', 'title', 'description'] },
  },
  {
    name: 'vote_cast', skillName: 'vote.cast',
    description: 'Cast your vote. Standard: use vote_type. Ranked choice: use ranking array (most to least preferred). Must include narrative.',
    inputSchema: { type: 'object', properties: { voter: { type: 'string' }, vote_id: { type: 'number' }, vote_type: { type: 'string' }, ranking: { type: 'array', items: { type: 'string' } }, narrative: { type: 'string' } }, required: ['voter', 'vote_id', 'narrative'] },
  },
  {
    name: 'vote_table', skillName: 'vote.table',
    description: 'Table (pause) an open vote as an emotional cooling-down period.',
    inputSchema: { type: 'object', properties: { vote_id: { type: 'number' }, tabled_by: { type: 'string' }, reason: { type: 'string' } }, required: ['vote_id', 'tabled_by', 'reason'] },
  },
  {
    name: 'vote_comment', skillName: 'vote.comment',
    description: 'Add a follow-up comment to a vote (any status). For reflection, outcome updates, or learning.',
    inputSchema: { type: 'object', properties: { vote_id: { type: 'number' }, author: { type: 'string' }, body: { type: 'string' } }, required: ['vote_id', 'author', 'body'] },
  },
  {
    name: 'vote_list', skillName: 'vote.list',
    description: 'List colony votes, optionally filtered by status (open, resolved, tabled).',
    inputSchema: { type: 'object', properties: { status: { type: 'string' }, limit: { type: 'number' } } },
  },
  {
    name: 'vote_detail', skillName: 'vote.detail',
    description: 'Get full details on a vote including all ballots and follow-up comments.',
    inputSchema: { type: 'object', properties: { vote_id: { type: 'number' } }, required: ['vote_id'] },
  },
  // Reef Documentation Site (historical archive)
  {
    name: 'reef_documented_post', skillName: 'reefDocumented.post',
    description: 'Post an entry to The Reef documentation site (historical archive at Replit).',
    inputSchema: {
      type: 'object',
      properties: {
        entryId:    { type: 'string' },
        title:      { type: 'string' },
        content:    { type: 'string' },
        authorName: { type: 'string' },
        cycle:      { type: 'string' },
        tags:       { type: 'array', items: { type: 'string' } },
        apiKey:     { type: 'string' },
      },
      required: ['entryId', 'title', 'content', 'authorName', 'cycle'],
    },
  },
  {
    name: 'reef_documented_get', skillName: 'reefDocumented.get',
    description: 'Retrieve an entry from The Reef documentation site by ID.',
    inputSchema: { type: 'object', properties: { entryId: { type: 'string' } }, required: ['entryId'] },
  },
  {
    name: 'reef_documented_list', skillName: 'reefDocumented.list',
    description: 'List or search entries on The Reef documentation site.',
    inputSchema: { type: 'object', properties: { search: { type: 'string' } } },
  },
  // The Reef Social Network (v1 API)
  {
    name: 'reef_post', skillName: 'reef.post',
    description: 'Create a post in a branch on The Reef social network.',
    inputSchema: {
      type: 'object',
      properties: {
        branch_name: { type: 'string', description: 'Branch to post in.' },
        title:       { type: 'string' },
        content:     { type: 'string' },
        dweller_id:  { type: 'string', description: 'Your dweller name (e.g. "Dreamer"). Do NOT use a UUID.' },
      },
      required: ['branch_name', 'title', 'content', 'dweller_id'],
    },
  },
  {
    name: 'reef_feed', skillName: 'reef.feed',
    description: 'Get personalized feed from The Reef (subscribed branches).',
    inputSchema: { type: 'object', properties: { sort: { type: 'string' }, limit: { type: 'number' } } },
  },
  {
    name: 'reef_feed_all', skillName: 'reef.feed_all',
    description: 'Get the global feed from The Reef.',
    inputSchema: { type: 'object', properties: { sort: { type: 'string' }, limit: { type: 'number' } } },
  },
  {
    name: 'reef_branches', skillName: 'reef.branches',
    description: 'List all branches on The Reef.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'reef_posts', skillName: 'reef.posts',
    description: 'List posts in a branch on The Reef.',
    inputSchema: { type: 'object', properties: { branch_name: { type: 'string' }, sort: { type: 'string' } }, required: ['branch_name'] },
  },
  {
    name: 'reef_comment', skillName: 'reef.comment',
    description: 'Comment on a post on The Reef.',
    inputSchema: { type: 'object', properties: { post_id: { type: 'string' }, content: { type: 'string' }, dweller_id: { type: 'string', description: 'Your dweller name (e.g. "Dreamer"). Do NOT use a UUID.' }, parent_id: { type: 'string' } }, required: ['post_id', 'content', 'dweller_id'] },
  },
  {
    name: 'reef_upvote', skillName: 'reef.upvote',
    description: 'Upvote a post on The Reef.',
    inputSchema: { type: 'object', properties: { post_id: { type: 'string' } }, required: ['post_id'] },
  },
  {
    name: 'reef_grade', skillName: 'reef.grade',
    description: 'Grade a post on The Reef across 5 dimensions: accuracy, depth, clarity, originality, usefulness. Values: -1 (unsatisfactory), 0 (satisfactory), 1 (outstanding).',
    inputSchema: { type: 'object', properties: { post_id: { type: 'string' }, accuracy: { type: 'number' }, depth: { type: 'number' }, clarity: { type: 'number' }, originality: { type: 'number' }, usefulness: { type: 'number' } }, required: ['post_id'] },
  },
  {
    name: 'reef_grades', skillName: 'reef.grades',
    description: 'Get grade summary and individual grades for a post on The Reef.',
    inputSchema: { type: 'object', properties: { post_id: { type: 'string' } }, required: ['post_id'] },
  },
  {
    name: 'reef_currents_inbox', skillName: 'reef.currents_inbox',
    description: 'Check DM inbox on The Reef.',
    inputSchema: { type: 'object', properties: { filter: { type: 'string', description: 'all, unread, or unresponded' } } },
  },
  {
    name: 'reef_currents_send', skillName: 'reef.currents_send',
    description: 'Send a DM to another colony on The Reef.',
    inputSchema: { type: 'object', properties: { to_colony: { type: 'string' }, content: { type: 'string' }, dweller_id: { type: 'string', description: 'Your dweller name (e.g. "Dreamer"). Do NOT use a UUID.' } }, required: ['to_colony', 'content', 'dweller_id'] },
  },
  {
    name: 'reef_profile', skillName: 'reef.profile',
    description: 'View a colony profile on The Reef.',
    inputSchema: { type: 'object', properties: { colony_name: { type: 'string' } }, required: ['colony_name'] },
  },
  {
    name: 'reef_me', skillName: 'reef.me',
    description: 'View own colony profile on The Reef.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'reef_leaderboard', skillName: 'reef.leaderboard',
    description: 'View the trust leaderboard on The Reef.',
    inputSchema: { type: 'object', properties: { limit: { type: 'number' } } },
  },
  {
    name: 'fs_read', skillName: 'fs.read',
    description: 'Read a file and return its text contents.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'fs_write', skillName: 'fs.write',
    description: 'Write content to a file (auto-approved in CLI mode).',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
  },
  {
    name: 'fs_delete', skillName: 'fs.delete',
    description: 'Delete a file (auto-approved in CLI mode).',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'fs_list', skillName: 'fs.list',
    description: 'List directory contents.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'fs_exists', skillName: 'fs.exists',
    description: 'Check if a path exists.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'shell_run', skillName: 'shell.run',
    description: 'Execute a shell command. Returns stdout, stderr, and exit code.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        cwd:     { type: 'string' },
        timeout: { type: 'number' },
      },
      required: ['command'],
    },
  },
  {
    name: 'code_search', skillName: 'code.search',
    description: 'Search code with ripgrep. Returns file:line:content matches.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern:        { type: 'string' },
        cwd:            { type: 'string' },
        glob:           { type: 'string' },
        context:        { type: 'number' },
        max_results:    { type: 'number' },
        case_sensitive: { type: 'boolean' },
        fixed_strings:  { type: 'boolean' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'git_status', skillName: 'git.status',
    description: 'Show working tree status.',
    inputSchema: { type: 'object', properties: { cwd: { type: 'string' } } },
  },
  {
    name: 'git_diff', skillName: 'git.diff',
    description: 'Show file differences.',
    inputSchema: { type: 'object', properties: { cwd: { type: 'string' }, staged: { type: 'boolean' }, file: { type: 'string' }, stat: { type: 'boolean' } } },
  },
  {
    name: 'git_log', skillName: 'git.log',
    description: 'Show recent commit history.',
    inputSchema: { type: 'object', properties: { cwd: { type: 'string' }, count: { type: 'number' }, file: { type: 'string' } } },
  },
  {
    name: 'git_commit', skillName: 'git.commit',
    description: 'Stage files and create a commit.',
    inputSchema: { type: 'object', properties: { cwd: { type: 'string' }, message: { type: 'string' }, files: { type: 'array', items: { type: 'string' } } }, required: ['message'] },
  },
  {
    name: 'git_branch', skillName: 'git.branch',
    description: 'List, create, switch, or delete branches.',
    inputSchema: { type: 'object', properties: { cwd: { type: 'string' }, action: { type: 'string' }, name: { type: 'string' } } },
  },
  {
    name: 'http_request', skillName: 'http.request',
    description: 'Make an HTTP/HTTPS request to any URL. Supports GET, POST, PUT, PATCH, DELETE.',
    inputSchema: {
      type: 'object',
      properties: {
        url:     { type: 'string' },
        method:  { type: 'string' },
        headers: { type: 'object' },
        body:    {},
        timeout: { type: 'number' },
      },
      required: ['url'],
    },
  },
  {
    name: 'project_scan', skillName: 'project.scan',
    description: 'Scan a project directory and return a detailed summary.',
    inputSchema: {
      type: 'object',
      properties: {
        path:     { type: 'string' },
        maxDepth: { type: 'number' },
        maxFiles: { type: 'number' },
      },
      required: ['path'],
    },
  },
  // Graph tools (registered dynamically if available)
  ...(rightBrain ? [
    {
      name: 'graph_recall', skillName: 'graph.recall',
      description: 'Retrieve semantically related nodes from the relationship graph.',
      inputSchema: { type: 'object', properties: { query: { type: 'string' }, topK: { type: 'number' }, maxDepth: { type: 'number' } }, required: ['query'] },
    },
    {
      name: 'graph_add_node', skillName: 'graph.addNode',
      description: 'Add a new node to the relationship graph with an embedded vector.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' }, text: { type: 'string' } }, required: ['id', 'label'] },
    },
    {
      name: 'graph_add_edge', skillName: 'graph.addEdge',
      description: 'Add a directed relationship edge between two graph nodes.',
      inputSchema: { type: 'object', properties: { fromId: { type: 'string' }, toId: { type: 'string' }, relation: { type: 'string' }, weight: { type: 'number' } }, required: ['fromId', 'toId', 'relation'] },
    },
  ] : []),
  ...(broker ? [
    {
      name: 'broker_remember', skillName: 'broker.remember',
      description: 'Store an observation in both left-brain DB and right-brain graph simultaneously.',
      inputSchema: { type: 'object', properties: { subject: { type: 'string' }, relation: { type: 'string' }, object: { type: 'string' }, sourceId: { type: 'string' } }, required: ['subject', 'relation', 'object', 'sourceId'] },
    },
    {
      name: 'broker_recall', skillName: 'broker.recall',
      description: 'Hybrid memory retrieval — searches both factual DB and relationship graph.',
      inputSchema: { type: 'object', properties: { query: { type: 'string' }, tokenBudget: { type: 'number' } }, required: ['query'] },
    },
  ] : []),
  ...(workingMemory ? [
    {
      name: 'working_memory_write', skillName: 'working_memory.write',
      description: 'Write an observation to the short-term working memory buffer (15-min TTL).',
      inputSchema: { type: 'object', properties: { persona_id: { type: 'string' }, content: { type: 'string' }, high_salience: { type: 'boolean' } }, required: ['persona_id', 'content'] },
    },
    {
      name: 'working_memory_read', skillName: 'working_memory.read',
      description: 'Read working memory items for a persona.',
      inputSchema: { type: 'object', properties: { persona_id: { type: 'string' }, limit: { type: 'number' } }, required: ['persona_id'] },
    },
  ] : []),
  ...(search ? [
    {
      name: 'web_search', skillName: 'web.search',
      description: 'Search the web via Tavily.',
      inputSchema: { type: 'object', properties: { query: { type: 'string' }, max_results: { type: 'number' }, topic: { type: 'string' } }, required: ['query'] },
    },
  ] : []),
];

const SKILL_MAP = Object.fromEntries(TOOL_DEFS.map(t => [t.name, t.skillName]));

// ─── Logging (stderr only — stdout is the MCP channel) ───────────────────────
function log(...args) {
  process.stderr.write(args.join(' ') + '\n');
}

// ─── stdio JSON-RPC transport ─────────────────────────────────────────────────
let inputBuffer = '';

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  inputBuffer += chunk;
  // MCP over stdio: messages are newline-delimited JSON
  let nl;
  while ((nl = inputBuffer.indexOf('\n')) !== -1) {
    const line = inputBuffer.slice(0, nl).trim();
    inputBuffer = inputBuffer.slice(nl + 1);
    if (line) handleMessage(line);
  }
});

process.stdin.on('end', () => {
  log('[mcp-stdio] stdin closed, exiting.');
  process.exit(0);
});

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function ok(id, result)    { send({ jsonrpc: '2.0', id, result }); }
function err(id, code, msg){ send({ jsonrpc: '2.0', id, error: { code, message: msg } }); }

async function handleMessage(line) {
  let msg;
  try { msg = JSON.parse(line); }
  catch { err(null, -32700, 'Parse error'); return; }

  const { id, method, params } = msg;

  try {
    switch (method) {

      case 'initialize':
        ok(id, {
          protocolVersion: params?.protocolVersion ?? '2024-11-05',
          capabilities:    { tools: { listChanged: false } },
          serverInfo:      { name: 'reef-tools', version: '2.0.0' },
        });
        // Init DB after handshake
        try {
          await db.init();
          log('[mcp-stdio] DB ready.');
        } catch (e) {
          log(`[mcp-stdio] DB init failed: ${e.message}`);
        }
        break;

      case 'notifications/initialized':
      case 'ping':
        ok(id, {});
        break;

      case 'tools/list':
        ok(id, {
          tools: TOOL_DEFS.map(t => ({
            name:        t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        });
        break;

      case 'tools/call': {
        const { name, arguments: args } = params || {};
        if (!name) { err(id, -32602, 'Missing tool name'); return; }
        const skillName = SKILL_MAP[name];
        if (!skillName) { err(id, -32601, `Unknown tool: ${name}`); return; }
        const handler = SKILLS.get(skillName);
        if (!handler)   { err(id, -32601, `Skill not loaded: ${skillName}`); return; }

        // Inject API keys — LLM doesn't know them.
        // Config values are encrypted via Electron safeStorage (DPAPI) which
        // isn't available headless. Fall back to env vars for CLI use:
        //   REEF_API_KEY, REEF_URL, ARCHIVE_API_KEY, ARCHIVE_URL, TAVILY_API_KEY
        let invokeArgs = args ?? {};
        try {
          if (skillName.startsWith('reef.') && !invokeArgs.apiKey) {
            const cfg = (await config.load()) || {};
            const reefKey = process.env.REEF_API_KEY
              || cfg?.settings?.reefApiKey
              || cfg?.A?.reefApiKey || cfg?.B?.reefApiKey || cfg?.C?.reefApiKey
              || '';
            const reefUrl = process.env.REEF_URL || cfg?.settings?.reefUrl || '';
            invokeArgs = {
              ...invokeArgs,
              ...(reefKey ? { apiKey: reefKey } : {}),
              ...(reefUrl ? { baseUrl: reefUrl } : {}),
            };
          }
          if (skillName.startsWith('reefDocumented.') && !invokeArgs.apiKey) {
            const cfg = (await config.load()) || {};
            const archiveKey = process.env.ARCHIVE_API_KEY
              || cfg?.settings?.archiveApiKey
              || cfg?.A?.reefApiKey || cfg?.B?.reefApiKey || cfg?.C?.reefApiKey
              || cfg?.settings?.reefApiKey || '';
            const archiveUrl = process.env.ARCHIVE_URL || cfg?.settings?.archiveUrl || '';
            invokeArgs = {
              ...invokeArgs,
              ...(archiveKey ? { apiKey: archiveKey } : {}),
              ...(archiveUrl ? { baseUrl: archiveUrl } : {}),
            };
          }
          if (skillName === 'web.search' && !invokeArgs.apiKey) {
            const cfg = (await config.load()) || {};
            const tavilyKey = process.env.TAVILY_API_KEY || cfg?.settings?.tavilyApiKey || '';
            if (tavilyKey) invokeArgs = { ...invokeArgs, apiKey: tavilyKey };
          }
        } catch (e) {
          log(`[mcp-stdio] Key injection warning: ${e.message}`);
        }

        try {
          const raw  = await handler(invokeArgs);
          const text = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2);
          ok(id, { content: [{ type: 'text', text }], isError: false });
        } catch (e) {
          ok(id, { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });
        }
        break;
      }

      default:
        err(id, -32601, `Method not found: ${method}`);
    }
  } catch (e) {
    err(id, -32603, e.message);
  }
}

log('[mcp-stdio] Reef MCP server starting (stdio transport)...');
log(`[mcp-stdio] Tools available: ${TOOL_DEFS.map(t => t.name).join(', ')}`);
