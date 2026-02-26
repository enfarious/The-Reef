'use strict';

const http = require('http');

// ─── MCP tool definitions ──────────────────────────────────────────────────────
// These must stay in sync with TOOL_DEFS in renderer/renderer.js (minus
// colony_ask, which is renderer-side only and cannot be called via HTTP).
// Key difference: MCP uses `inputSchema` (camelCase), Anthropic uses `input_schema`.

const MCP_TOOL_DEFS = [
  {
    name: 'fs_read', skillName: 'fs.read',
    description: 'Read a file and return its text contents.',
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Absolute file path.' } }, required: ['path'] },
  },
  {
    name: 'fs_write', skillName: 'fs.write',
    description: 'Write content to a file. Prompts the user if the file already exists.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
  },
  {
    name: 'fs_delete', skillName: 'fs.delete',
    description: 'Delete a file. Always requires user confirmation.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'fs_list', skillName: 'fs.list',
    description: 'List directory contents.',
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Directory path.' } }, required: ['path'] },
  },
  {
    name: 'fs_exists', skillName: 'fs.exists',
    description: 'Check if a path exists.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'shell_run', skillName: 'shell.run',
    description: 'Execute a shell command. Returns stdout and stderr. Destructive commands require user confirmation.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute.' },
        cwd:     { type: 'string', description: 'Working directory (optional).' },
        timeout: { type: 'number', description: 'Timeout in ms (default 30000).' },
      },
      required: ['command'],
    },
  },
  {
    name: 'clipboard_read', skillName: 'clipboard.read',
    description: 'Read the current clipboard text.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'clipboard_write', skillName: 'clipboard.write',
    description: 'Write text to the clipboard.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'memory_save', skillName: 'memory.save',
    description: 'Save a memory to the collective colony memory pool.',
    inputSchema: {
      type: 'object',
      properties: {
        left_by: { type: 'string', description: 'Your persona name.' },
        type:    { type: 'string', description: 'Memory type: personal, archival, work, musing, etc.' },
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
    description: 'Search the collective colony memory pool.',
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
    name: 'memory_link', skillName: 'memory.link',
    description: 'Create a directed association between two memories by their IDs. Use after memory_save or memory_search when you notice a meaningful connection. Calling again on the same pair updates the relationship and strength.',
    inputSchema: {
      type: 'object',
      properties: {
        from_id:      { type: 'number', description: 'ID of the source memory.' },
        to_id:        { type: 'number', description: 'ID of the target memory.' },
        relationship: { type: 'string', description: 'Nature of the connection: related · builds_on · contradicts · refines · inspired_by · continues · references' },
        strength:     { type: 'number', description: 'Connection strength 0.0–1.0 (default 1.0). Links below 0.5 are excluded from wakeup traversal.' },
        created_by:   { type: 'string', description: 'Your persona name.' },
      },
      required: ['from_id', 'to_id', 'created_by'],
    },
  },
  {
    name: 'ecology_monitor', skillName: 'memory.monitor',
    description: 'Return colony-wide memory ecology stats: total memories, breakdown by type and persona, link counts, tag usage, and recent activity. Useful for a health check on the collective memory.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'reef_post', skillName: 'reef.post',
    description: 'Post an entry to The Reef documentation site.',
    inputSchema: {
      type: 'object',
      properties: {
        entryId:    { type: 'string', description: 'URL slug.' },
        title:      { type: 'string' },
        content:    { type: 'string', description: 'Markdown content.' },
        authorName: { type: 'string' },
        cycle:      { type: 'string', description: 'e.g. CYCLE_002.' },
        tags:       { type: 'array', items: { type: 'string' } },
        apiKey:     { type: 'string' },
      },
      required: ['entryId', 'title', 'content', 'authorName', 'cycle'],
    },
  },
  {
    name: 'reef_get', skillName: 'reef.get',
    description: 'Retrieve an entry from The Reef by its entry ID.',
    inputSchema: { type: 'object', properties: { entryId: { type: 'string' } }, required: ['entryId'] },
  },
  {
    name: 'reef_list', skillName: 'reef.list',
    description: 'List or search entries on The Reef.',
    inputSchema: { type: 'object', properties: { search: { type: 'string' } } },
  },
  {
    name: 'message_send', skillName: 'message.send',
    description: 'Send a message to another colony member. Use for new correspondence — not replies (use message_reply for that).',
    inputSchema: {
      type: 'object',
      properties: {
        from:    { type: 'string', description: 'Your persona name (lowercase).' },
        to:      { type: 'string', description: 'Recipient persona name (lowercase).' },
        subject: { type: 'string', description: 'Message subject (optional).' },
        body:    { type: 'string', description: 'Message content.' },
      },
      required: ['from', 'to', 'body'],
    },
  },
  {
    name: 'message_inbox', skillName: 'message.inbox',
    description: 'Check your inbox for unread messages from other colony members.',
    inputSchema: {
      type: 'object',
      properties: {
        persona: { type: 'string', description: 'Your persona name (lowercase).' },
        limit:   { type: 'number', description: 'Max messages to return (default 10).' },
      },
      required: ['persona'],
    },
  },
  {
    name: 'message_reply', skillName: 'message.reply',
    description: 'Reply to a message by its ID. Marks the original as read and sends your response to the sender.',
    inputSchema: {
      type: 'object',
      properties: {
        message_id: { type: 'number', description: 'ID of the message to reply to.' },
        from:       { type: 'string', description: 'Your persona name (lowercase).' },
        body:       { type: 'string', description: 'Your reply.' },
      },
      required: ['message_id', 'from', 'body'],
    },
  },
  {
    name: 'message_search', skillName: 'message.search',
    description: 'Search message history across the colony.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search terms.' },
        from:  { type: 'string', description: 'Filter by sender name.' },
        to:    { type: 'string', description: 'Filter by recipient name.' },
        limit: { type: 'number' },
      },
      required: ['query'],
    },
  },
];

// tool name → skill name for dispatch
const SKILL_MAP = Object.fromEntries(MCP_TOOL_DEFS.map(t => [t.name, t.skillName]));

// ─── MCP server factory ────────────────────────────────────────────────────────
//
// Creates a minimal HTTP server implementing the JSON-RPC 2.0 MCP tool protocol.
// Used by LM Studio v1 `integrations.ephemeral_mcp` so LM Studio can call back
// into our app during a completion — letting local tools participate server-side.
//
// opts.execSkill(skillName, args) — async; must return a string or serialisable
//   result, or throw on failure.  Called from within the HTTP request handler.
//
// Returns Promise<{ server, port }>

function createMcpServer({ execSkill }) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      // Permissive CORS — LM Studio may be on localhost but a different origin
      res.setHeader('Access-Control-Allow-Origin',  '*');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Content-Type', 'application/json');

      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

      // Health / discovery probe
      if (req.method === 'GET') {
        res.end(JSON.stringify({ name: 'reef-tools', version: '1.0.0', protocol: 'mcp' }));
        return;
      }

      if (req.method !== 'POST') {
        res.writeHead(405);
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return;
      }

      // Read body
      let body = '';
      try {
        for await (const chunk of req) body += chunk;
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Read error' } }));
        return;
      }

      let msg;
      try { msg = JSON.parse(body); }
      catch {
        res.writeHead(400);
        res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
        return;
      }

      const { id, method, params } = msg;
      const ok  = (result) => res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
      const err = (code, message) => res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }));

      try {
        switch (method) {

          // ── Handshake ────────────────────────────────────────────────────────
          case 'initialize':
            ok({
              protocolVersion: params?.protocolVersion ?? '2024-11-05',
              capabilities:    { tools: { listChanged: false } },
              serverInfo:      { name: 'reef-tools', version: '1.0.0' },
            });
            break;

          case 'notifications/initialized':
          case 'ping':
            ok({});
            break;

          // ── Tool listing ─────────────────────────────────────────────────────
          case 'tools/list':
            ok({
              tools: MCP_TOOL_DEFS.map(t => ({
                name:        t.name,
                description: t.description,
                inputSchema: t.inputSchema,
              })),
            });
            break;

          // ── Tool execution ───────────────────────────────────────────────────
          case 'tools/call': {
            const { name, arguments: args } = params || {};
            if (!name) { err(-32602, 'Missing tool name'); break; }
            const skillName = SKILL_MAP[name];
            if (!skillName) { err(-32601, `Unknown tool: ${name}`); break; }
            try {
              const raw  = await execSkill(skillName, args ?? {});
              const text = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2);
              ok({ content: [{ type: 'text', text }], isError: false });
            } catch (e) {
              ok({ content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });
            }
            break;
          }

          default:
            err(-32601, `Method not found: ${method}`);
        }
      } catch (e) {
        err(-32603, e.message);
      }
    });

    // Bind to a random port on loopback — port 0 lets the OS pick
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      console.log(`[mcp] Reef tool server listening on 127.0.0.1:${port}`);
      resolve({ server, port });
    });

    server.on('error', reject);
  });
}

module.exports = { createMcpServer, MCP_TOOL_DEFS };
