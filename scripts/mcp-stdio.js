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
 *       "env": {}
 *     }
 *   }
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
      app:         { getPath: () => require('path').join(__dirname, '..') },
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

// ─── Skill registry (subset safe for headless/stdio use) ─────────────────────
const memory     = require('../skills/memory');
const message    = require('../skills/message');
const reef       = require('../skills/reef');
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
  // Reef API
  ['reef.post',   (a) => reef.post(a)],
  ['reef.get',    (a) => reef.get(a)],
  ['reef.list',   (a) => reef.list(a)],
  ['reef.update', (a) => reef.update(a)],
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
  {
    name: 'reef_post', skillName: 'reef.post',
    description: 'Post an entry to The Reef documentation site.',
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
    name: 'reef_get', skillName: 'reef.get',
    description: 'Retrieve a Reef entry by ID.',
    inputSchema: { type: 'object', properties: { entryId: { type: 'string' } }, required: ['entryId'] },
  },
  {
    name: 'reef_list', skillName: 'reef.list',
    description: 'List or search Reef entries.',
    inputSchema: { type: 'object', properties: { search: { type: 'string' } } },
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

        try {
          const raw  = await handler(args ?? {});
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
