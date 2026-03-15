// ─── Tool definitions, topic scoring, contextual filtering ──────────────────
//
// Canonical Anthropic-format schemas.  llm.js converts to OpenAI format when
// the endpoint needs it.  colony_ask has no skillName — it's handled entirely
// renderer-side in executeColonyAsk().

import { PERSONAS, state } from './state.js';

export const TOOL_DEFS = [
  {
    name: 'fs_read', skillName: 'fs.read',
    description: 'Read a file and return its text contents.',
    input_schema: { type: 'object', properties: { path: { type: 'string', description: 'Absolute file path.' } }, required: ['path'] },
  },
  {
    name: 'fs_write', skillName: 'fs.write',
    description: 'Write content to a file. Prompts the user if the file already exists.',
    input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
  },
  {
    name: 'fs_delete', skillName: 'fs.delete',
    description: 'Delete a file. Always requires user confirmation.',
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'fs_list', skillName: 'fs.list',
    description: 'List directory contents.',
    input_schema: { type: 'object', properties: { path: { type: 'string', description: 'Directory path.' } }, required: ['path'] },
  },
  {
    name: 'fs_exists', skillName: 'fs.exists',
    description: 'Check if a path exists.',
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'shell_run', skillName: 'shell.run',
    description: 'Execute a shell command. Returns stdout and stderr. Destructive commands require user confirmation. WINDOWS HOST: Commands run via Git Bash if available (use Unix syntax: ls, cat, grep, etc.), otherwise via PowerShell. Prefer Unix commands when Git Bash is likely present (Git is installed). Use "node", "npm", "npx" for JS tasks.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute. Unix syntax preferred (ls, cat, grep, find, etc.) — Git Bash is used when available.' },
        cwd:     { type: 'string', description: 'Working directory (optional).' },
        timeout: { type: 'number', description: 'Timeout in ms (default 30000).' },
      },
      required: ['command'],
    },
  },
  {
    name: 'clipboard_read', skillName: 'clipboard.read',
    description: 'Read the current clipboard text.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'clipboard_write', skillName: 'clipboard.write',
    description: 'Write text to the clipboard.',
    input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'memory_save', skillName: 'memory.save',
    description: 'Save a memory to the collective colony memory pool.',
    input_schema: {
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
    input_schema: {
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
    input_schema: {
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
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'memory_dedupe', skillName: 'memory.dedupe',
    description: 'Find duplicate or near-duplicate memories and optionally delete the older copies. Run with dry_run: true first to preview what would be removed.',
    input_schema: {
      type: 'object',
      properties: {
        dry_run:   { type: 'boolean', description: 'Preview duplicates without deleting. Default true.' },
        threshold: { type: 'number',  description: 'Similarity threshold 0.0–1.0 (default 0.85). Uses trigram similarity if pg_trgm is available, exact match otherwise.' },
        left_by:   { type: 'string',  description: 'Only scan memories where at least one copy is from this persona.' },
      },
    },
  },
  {
    name: 'reef_post', skillName: 'reef.post',
    description: 'Post an entry to The Reef documentation site.',
    input_schema: {
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
    input_schema: { type: 'object', properties: { entryId: { type: 'string' } }, required: ['entryId'] },
  },
  {
    name: 'reef_list', skillName: 'reef.list',
    description: 'List or search entries on The Reef.',
    input_schema: { type: 'object', properties: { search: { type: 'string' } } },
  },
  {
    name: 'message_send', skillName: 'message.send',
    description: 'Send a message to another colony member. Use for new correspondence — not replies (use message_reply for that).',
    input_schema: {
      type: 'object',
      properties: {
        from:    { type: 'string', description: 'Your persona name (lowercase).' },
        to: {
          anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
          description: 'Recipient: a persona name, an array of names e.g. ["dreamer","builder"], or "all" for a colony-wide broadcast. One message row is stored regardless of recipient count.',
        },
        subject: { type: 'string', description: 'Message subject (optional).' },
        body:    { type: 'string', description: 'Message content.' },
      },
      required: ['from', 'to', 'body'],
    },
  },
  {
    name: 'message_inbox', skillName: 'message.inbox',
    description: 'Check your inbox for unread messages from other colony members.',
    input_schema: {
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
    input_schema: {
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
    input_schema: {
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
  {
    name: 'code_search', skillName: 'code.search',
    description: 'Search code in the workspace using ripgrep. Returns file:line:content matches.',
    input_schema: {
      type: 'object',
      properties: {
        pattern:       { type: 'string',  description: 'Regex pattern to search for.' },
        cwd:           { type: 'string',  description: 'Directory to search (default: workspace root).' },
        glob:          { type: 'string',  description: 'File filter glob, e.g. "*.js" or "*.{ts,tsx}".' },
        context:       { type: 'number',  description: 'Lines of context around each match (default 0).' },
        max_results:   { type: 'number',  description: 'Max matches to return (default 50).' },
        case_sensitive: { type: 'boolean', description: 'Case-sensitive search (default true).' },
        fixed_strings:  { type: 'boolean', description: 'Treat pattern as literal, not regex (default false).' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'git_status', skillName: 'git.status',
    description: 'Show the working tree status (short format).',
    input_schema: { type: 'object', properties: { cwd: { type: 'string' } } },
  },
  {
    name: 'git_diff', skillName: 'git.diff',
    description: 'Show file differences. Use staged=true for staged changes.',
    input_schema: {
      type: 'object',
      properties: {
        cwd:    { type: 'string' },
        staged: { type: 'boolean', description: 'Show staged (--cached) diff (default false).' },
        file:   { type: 'string',  description: 'Limit diff to a specific file.' },
        stat:   { type: 'boolean', description: 'Show only a summary of changed files (default false).' },
      },
    },
  },
  {
    name: 'git_log', skillName: 'git.log',
    description: 'Show recent commit history.',
    input_schema: {
      type: 'object',
      properties: {
        cwd:   { type: 'string' },
        count: { type: 'number', description: 'Number of commits to show (default 20, max 100).' },
        file:  { type: 'string', description: 'Limit history to a specific file.' },
      },
    },
  },
  {
    name: 'git_commit', skillName: 'git.commit',
    description: 'Stage files and create a commit. If files is omitted, commits whatever is already staged.',
    input_schema: {
      type: 'object',
      properties: {
        cwd:     { type: 'string' },
        message: { type: 'string', description: 'Commit message.' },
        files:   { type: 'array', items: { type: 'string' }, description: 'Files to stage before committing.' },
      },
      required: ['message'],
    },
  },
  {
    name: 'git_branch', skillName: 'git.branch',
    description: 'List, create, switch, or delete branches.',
    input_schema: {
      type: 'object',
      properties: {
        cwd:    { type: 'string' },
        action: { type: 'string', description: '"list" (default), "create", "switch", or "delete".' },
        name:   { type: 'string', description: 'Branch name (required for create/switch/delete).' },
      },
    },
  },
  {
    name: 'git_push', skillName: 'git.push',
    description: 'Push commits to a remote repository.',
    input_schema: {
      type: 'object',
      properties: {
        cwd:    { type: 'string' },
        remote: { type: 'string', description: 'Remote name (default "origin").' },
        branch: { type: 'string', description: 'Branch to push.' },
      },
    },
  },
  {
    name: 'reddit_search', skillName: 'reddit.search',
    description: 'Search Reddit for posts matching a query, optionally within a specific subreddit.',
    input_schema: {
      type: 'object',
      properties: {
        query:     { type: 'string', description: 'Search query.' },
        subreddit: { type: 'string', description: 'Limit to a subreddit (e.g. "javascript"). Omit to search all of Reddit.' },
        sort:      { type: 'string', description: '"relevance" (default), "hot", "top", "new", or "comments".' },
        limit:     { type: 'number', description: 'Number of posts (default 10, max 25).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'reddit_hot', skillName: 'reddit.hot',
    description: "Browse a subreddit's hot, new, or top posts.",
    input_schema: {
      type: 'object',
      properties: {
        subreddit: { type: 'string', description: 'Subreddit name (e.g. "node", "webdev").' },
        sort:      { type: 'string', description: '"hot" (default), "new", or "top".' },
        limit:     { type: 'number', description: 'Number of posts (default 10, max 25).' },
        time:      { type: 'string', description: 'Time range for "top": "hour", "day", "week" (default), "month", "year", "all".' },
      },
      required: ['subreddit'],
    },
  },
  {
    name: 'reddit_post', skillName: 'reddit.post',
    description: 'Read a specific Reddit post and its top comments. Provide either a URL or post ID.',
    input_schema: {
      type: 'object',
      properties: {
        url:    { type: 'string', description: 'Full Reddit post URL.' },
        postId: { type: 'string', description: 'Reddit post ID (the short code from the URL).' },
        limit:  { type: 'number', description: 'Number of top comments to include (default 15, max 30).' },
      },
    },
  },
  {
    name: 'web_search', skillName: 'web.search',
    description: 'Search the web via Tavily and return an AI-synthesised answer plus source results.',
    input_schema: {
      type: 'object',
      properties: {
        query:        { type: 'string', description: 'Search query.' },
        max_results:  { type: 'number', description: 'Number of results to return (default 5, max 10).' },
        topic:        { type: 'string', description: '"general" (default) or "news".' },
        search_depth: { type: 'string', description: '"basic" (default, faster) or "advanced" (deeper, uses more credits).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'vision_screenshot', skillName: 'vision.screenshot',
    description: 'Capture a screenshot of the screen. Returns the image for you to see and analyze visually.',
    input_schema: {
      type: 'object',
      properties: {
        display:  { type: 'integer', description: 'Display index (0 = primary). Default 0.' },
        maxWidth: { type: 'integer', description: 'Max image width in pixels. Default 1920.' },
        quality:  { type: 'integer', description: 'JPEG quality 10–100. Default 80.' },
      },
    },
  },
  {
    name: 'vision_read_image', skillName: 'vision.readImage',
    description: 'Read an image file from disk and return it for you to see and analyze visually.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the image file (PNG, JPG, GIF, WebP, BMP).' },
      },
      required: ['path'],
    },
  },
  {
    name: 'project_scan', skillName: 'project.scan',
    description: 'Scan a project directory and return its full structure, detected type, and key config file contents. Use to understand a codebase before working on it.',
    input_schema: {
      type: 'object',
      properties: {
        path:     { type: 'string',  description: 'Absolute path to the project root. Defaults to the current workspace CWD.' },
        maxDepth: { type: 'integer', description: 'Max directory depth (default 3, max 5).' },
        maxFiles: { type: 'integer', description: 'Max files to list (default 300, max 500).' },
      },
    },
  },
  {
    name: 'http_request', skillName: 'http.request',
    description: 'Make an HTTP request to any URL. Use for APIs, webhooks, or fetching web content. Supports GET, POST, PUT, PATCH, DELETE.',
    input_schema: {
      type: 'object',
      properties: {
        url:     { type: 'string', description: 'Full URL to request (http:// or https://).' },
        method:  { type: 'string', description: 'HTTP method: GET, POST, PUT, PATCH, DELETE. Default GET.' },
        headers: { type: 'object', description: 'Custom request headers as key-value pairs.' },
        body:    { description: 'Request body — object (auto-serialised as JSON) or string.' },
        timeout: { type: 'number', description: 'Timeout in ms (default 30000, max 60000).' },
      },
      required: ['url'],
    },
  },
  {
    name: 'notify', skillName: 'notify.send',
    description: 'Send a desktop notification to the operator. Use when a long task completes, you need human input, or found something important during a heartbeat.',
    input_schema: {
      type: 'object',
      properties: {
        title:  { type: 'string', description: 'Notification title.' },
        body:   { type: 'string', description: 'Notification body text.' },
        silent: { type: 'boolean', description: 'If true, suppress the notification sound. Default false.' },
      },
    },
  },
  {
    name: 'schedule_task', skillName: 'schedule_task',
    description: 'Schedule a reminder or task for yourself to handle later. The message will be delivered after the specified delay.',
    input_schema: {
      type: 'object',
      properties: {
        delay:   { type: 'number', description: 'Delay in milliseconds before the task fires. Min 5000 (5s), max 86400000 (24h). Examples: 300000 = 5min, 3600000 = 1hr.' },
        message: { type: 'string', description: 'The reminder or task description that will be delivered to you.' },
      },
      required: ['delay', 'message'],
    },
  },
  {
    name: 'schedule_list', skillName: 'schedule_list',
    description: 'List all pending scheduled tasks across the colony.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'schedule_cancel', skillName: 'schedule_cancel',
    description: 'Cancel a pending scheduled task by its ID.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Task ID to cancel (from schedule_list).' },
      },
      required: ['id'],
    },
  },
  {
    name: 'colony_ask', skillName: 'colony_ask',
    description: 'Send a message to another colony member and receive their response. Use to consult, share observations, or request help.',
    input_schema: {
      type: 'object',
      properties: {
        to:      { type: 'string', description: 'Target colony member (use their current name, lowercase).' },
        message: { type: 'string', description: 'What you want to say or ask.' },
      },
      required: ['to', 'message'],
    },
  },
  {
    name: 'graph_recall', skillName: 'graph.recall',
    description: 'Associative memory retrieval via the relationship graph. Given a query, finds semantically similar concept nodes and traverses weighted edges to surface related context. Use when you want to find connections between ideas rather than exact matches — "why is Mike frustrated?", "what is blocking Ashes and Aether?", "what should I focus on today?"',
    input_schema: {
      type: 'object',
      properties: {
        query:     { type: 'string', description: 'What to look for. Natural language.' },
        topN:      { type: 'number', description: 'Number of anchor nodes to start traversal from (default 3).' },
        hops:      { type: 'number', description: 'Traversal depth from anchor nodes (default 2).' },
        minWeight: { type: 'number', description: 'Minimum edge weight to traverse (default 0.4). Higher = only strong associations.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'graph_add_node', skillName: 'graph.addNode',
    description: 'Add a concept node to the relationship graph. Use when you want to register an entity, idea, or concept so it can be connected to others via graph_add_edge.',
    input_schema: {
      type: 'object',
      properties: {
        id:    { type: 'string', description: 'Unique node identifier (snake_case, e.g. "rendering_bug", "mike", "ashes_and_aether").' },
        label: { type: 'string', description: 'Human-readable label.' },
        text:  { type: 'string', description: 'Descriptive text used to generate the semantic embedding for fuzzy matching.' },
      },
      required: ['id', 'label', 'text'],
    },
  },
  {
    name: 'graph_add_edge', skillName: 'graph.addEdge',
    description: 'Add a directed weighted relationship between two nodes in the graph. Both nodes must already exist (use graph_add_node first). Edges decay over time without reinforcement.',
    input_schema: {
      type: 'object',
      properties: {
        fromId:   { type: 'string', description: 'Source node ID.' },
        toId:     { type: 'string', description: 'Target node ID.' },
        relation: { type: 'string', description: 'Relationship label (e.g. "building", "frustrated_by", "blocks", "part_of").' },
        weight:   { type: 'number', description: 'Edge strength 0.0–1.0 (default 0.5). High-salience events should be 0.7–0.9.' },
        salience: { type: 'number', description: 'How cognitively significant this relationship is 0.0–1.0 (default 0.5). Affects decay rate.' },
      },
      required: ['fromId', 'toId', 'relation'],
    },
  },
  {
    name: 'broker_remember', skillName: 'broker.remember',
    description: 'Write a subject→relation→object triple to the distributed memory system. Stores the fact in the entity/attribute database (left brain) AND creates a weighted graph edge (right brain). Use for important, durable relationships: who builds what, what blocks what, how entities connect. More structured than memory_save — prefer this when you want the relationship to be traversable by future graph_recall queries.',
    input_schema: {
      type: 'object',
      properties: {
        subject:  { type: 'string', description: 'The entity this relationship starts from (e.g. "Mike", "Ashes and Aether").' },
        relation: { type: 'string', description: 'Relationship type, verb form (e.g. "building", "blocked_by", "uses", "frustrated_by").' },
        object:   { type: 'string', description: 'The entity this relationship points to (e.g. "Three.js", "rendering bug").' },
        sourceId: { type: 'string', description: 'Your persona name (dreamer, builder, librarian) or "mike" for operator-sourced facts.' },
        salience: { type: 'number', description: 'How significant this relationship is 0.0–1.0. Omit to auto-detect from content.' },
      },
      required: ['subject', 'relation', 'object', 'sourceId'],
    },
  },
  {
    name: 'broker_recall', skillName: 'broker.recall',
    description: 'Hybrid memory retrieval — searches both the factual database (left brain) and the relationship graph (right brain) simultaneously, then assembles unified context. More powerful than graph_recall alone: seeds graph traversal with high-salience episodic anchors. Use for synthesis queries: "what is Mike working on?", "what is blocking progress?", "what matters right now?"',
    input_schema: {
      type: 'object',
      properties: {
        query:       { type: 'string', description: 'What to recall. Natural language.' },
        tokenBudget: { type: 'number', description: 'Approximate token budget for assembled context (default 1500).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'working_memory_write', skillName: 'working_memory.write',
    description: 'Write an item to working memory — the short-term staging buffer before long-term consolidation. Items expire in 15 minutes unless reinforced or consolidated. Use for observations, inklings, or patterns you want to hold before deciding if they deserve a permanent memory. High-salience items consolidate earlier. Use persona_id "all" to deposit dream fragments visible to all colony members.',
    input_schema: {
      type: 'object',
      properties: {
        personaId:    { type: 'string', description: 'Your persona ID (A, B, C) or "all" to make it visible to everyone.' },
        content:      { type: 'string', description: 'The observation, inkling, or fragment to hold in working memory.' },
        salience:     { type: 'number', description: 'How cognitively significant this is 0.0–1.0 (default 0.5).' },
        highSalience: { type: 'boolean', description: 'Mark as high-salience. Reduces decay rate and lowers consolidation threshold.' },
      },
      required: ['personaId', 'content'],
    },
  },
  {
    name: 'working_memory_read', skillName: 'working_memory.read',
    description: 'Read active items from working memory for a persona. Returns your own items plus any "all"-addressed dream fragments from other colony members. Use during your Sleeper cycle to review what is in the staging buffer before consolidation.',
    input_schema: {
      type: 'object',
      properties: {
        personaId:  { type: 'string', description: 'Your persona ID (A, B, C).' },
        includeAll: { type: 'boolean', description: 'Include items addressed to "all" (dream fragments). Default true.' },
      },
      required: ['personaId'],
    },
  },
  {
    name: 'graph_consolidate', skillName: 'graph.consolidate',
    description: 'Run a consolidation pass on working memory for a persona. Clusters related recent observations by semantic similarity and compresses groups of 3+ into composite concept nodes in the relationship graph. Returns a summary of what was consolidated. Call during your Sleeper cycle after reviewing working memory.',
    input_schema: {
      type: 'object',
      properties: {
        personaId: { type: 'string', description: 'Persona ID to consolidate (A, B, or C). Use your own ID.' },
      },
      required: ['personaId'],
    },
  },
  {
    name: 'graph_arbitrate', skillName: 'graph.arbitrate',
    description: 'Run contradiction arbitration on the memory system. Automatically resolves conflicts where one source is significantly more trusted (gap > 0.2). Returns a list of contradictions that were auto-resolved and those that require your judgment. Call during your Sleeper cycle. If deferred items remain, review them and use broker_remember to write the correct version.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'graph_decay_pass', skillName: 'graph.runDecayPass',
    description: 'Manually trigger a graph maintenance pass outside the scheduled 6-hour window. Decays edge weights by salience tier, prunes edges below the threshold into cold storage, and sweeps expired working memory items. Call during your Sleeper cycle if memory feels cluttered or after a large consolidation run.',
    input_schema: {
      type: 'object',
      properties: {
        pruneThreshold: { type: 'number', description: 'Edge weight below which edges are pruned to cold storage (default 0.1). Lower = keep more; higher = prune more aggressively.' },
      },
    },
  },
];

// tool name → IPC skill name (colony_ask handled separately)
export const SKILL_MAP = Object.fromEntries(
  TOOL_DEFS.filter(t => t.skillName).map(t => [t.name, t.skillName])
);

// ─── Tool topic tags ─────────────────────────────────────────────────────────

const TOOL_TOPICS = {
  memory_save:           ['core'],
  memory_search:         ['core'],
  memory_link:           ['core'],
  ecology_monitor:       ['core'],
  memory_dedupe:         ['core'],
  message_send:          ['core'],
  message_inbox:         ['core'],
  message_reply:         ['core'],
  message_search:        ['core'],
  colony_ask:            ['core'],
  broker_remember:       ['core'],
  broker_recall:         ['core'],
  working_memory_write:  ['core'],
  working_memory_read:   ['core'],
  notify:                ['core'],
  fs_read:               ['files', 'code'],
  fs_write:              ['files', 'code'],
  fs_delete:             ['files'],
  fs_list:               ['files', 'code'],
  fs_exists:             ['files', 'code'],
  shell_run:             ['shell', 'code'],
  code_search:           ['code', 'files'],
  project_scan:          ['code', 'files'],
  git_status:            ['git', 'code'],
  git_diff:              ['git', 'code'],
  git_log:               ['git', 'code'],
  git_commit:            ['git', 'code'],
  git_branch:            ['git', 'code'],
  git_push:              ['git', 'code'],
  web_search:            ['web'],
  reddit_search:         ['web'],
  reddit_hot:            ['web'],
  reddit_post:           ['web'],
  http_request:          ['web'],
  clipboard_read:        ['web', 'files'],
  clipboard_write:       ['web', 'files'],
  vision_screenshot:     ['vision'],
  vision_read_image:     ['vision', 'files'],
  reef_post:             ['reef'],
  reef_get:              ['reef'],
  reef_list:             ['reef'],
  graph_recall:          ['core', 'graph'],
  graph_add_node:        ['graph'],
  graph_add_edge:        ['graph'],
  graph_consolidate:     ['graph'],
  graph_arbitrate:       ['graph'],
  graph_decay_pass:      ['graph'],
  schedule_task:         ['schedule'],
  schedule_list:         ['schedule'],
  schedule_cancel:       ['schedule'],
};

const PERSONA_TOPICS = {
  A: null,
  B: ['core', 'code', 'files', 'shell', 'git', 'web', 'vision', 'reef', 'schedule'],
  C: ['core', 'graph', 'reef', 'web', 'schedule'],
};

const TOPIC_KEYWORDS = {
  code:     /\b(code|coding|function|class|bug|error|debug|implement|refactor|script|js|javascript|typescript|python|html|css|node|npm|test|lint|compile|import|export|module|api|endpoint|syntax|variable|loop|async|await|promise|component|render)\b/i,
  files:    /\b(file|files|folder|directory|path|read|write|save|load|open|disk|csv|json|txt|config|.env|.json|.js|.ts|.py|.md|.html)\b/i,
  shell:    /\b(run|execute|command|terminal|shell|bash|npm|npx|node|install|build|start|deploy|script|process|output|stdout|stderr|exit|port|server|compile|watch|dev)\b/i,
  git:      /\b(git|commit|push|pull|branch|merge|diff|status|stash|checkout|clone|repo|repository|version control|pr|pull request|conflict|staged|unstaged)\b/i,
  web:      /\b(search|google|web|browse|reddit|url|http|api|request|fetch|scrape|news|article|link|online|internet|research|look up|find out)\b/i,
  vision:   /\b(screenshot|screen|image|photo|picture|visual|see|look at|capture|display|window|ui|interface|pixel)\b/i,
  reef:     /\b(reef|post|publish|document|documentation|entry|cycle|article|write up|log|record|public)\b/i,
  graph:    /\b(graph|consolidate|arbitrat|decay|node|edge|cluster|embed|semantic|association|weight|relationship|link|connect)\b/i,
  schedule: /\b(schedule|remind|later|timer|delay|future|in \d+ (minutes?|hours?)|set a reminder|todo|later)\b/i,
};

export function scoreTopics(personaId, conversationMessages, windowSize = 6) {
  const active = new Set(['core']);
  if (!conversationMessages?.length) return active;

  const window = conversationMessages.slice(-windowSize);
  const text   = window
    .map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join(' ');

  for (const [topic, rx] of Object.entries(TOPIC_KEYWORDS)) {
    if (rx.test(text)) active.add(topic);
  }

  return active;
}

export function contextualToolDefs(personaId, conversationMessages, { heartbeat = false } = {}) {
  const toolStates  = state.config.settings.toolStates  || {};
  const customTools = state.config.settings.customTools || [];
  const agentTools  = state.config[personaId]?.tools || null; // null = all

  const activeTopics  = scoreTopics(personaId, conversationMessages);
  const personaAllow  = PERSONA_TOPICS[personaId] ?? null;

  const currentNames = PERSONAS.map(p => (state.config[p.id].name || p.name).toLowerCase());

  const builtins = TOOL_DEFS.filter(t => {
    // Per-agent tool whitelist (when set, only listed tools pass)
    if (agentTools && !agentTools.includes(t.name)) return false;
    if (toolStates[t.name] === false) return false;
    if (toolStates[t.name] === true)  return true;
    if (heartbeat && t.name === 'reef_post') return false;

    const tags = TOOL_TOPICS[t.name];
    if (!tags) return true;
    if (personaAllow && !tags.some(tag => personaAllow.includes(tag))) return false;
    return tags.some(tag => activeTopics.has(tag));
  });

  const customs = customTools.filter(t => toolStates[t.name] !== false);

  return [...builtins, ...customs].map(t => {
    const { name, description, input_schema } = t;
    if (name === 'colony_ask') {
      return {
        name, description,
        input_schema: {
          ...input_schema,
          properties: {
            ...input_schema.properties,
            to: { ...input_schema.properties.to, enum: currentNames },
          },
        },
      };
    }
    return { name, description, input_schema };
  });
}

// Mirrors detectMode in llm.js — needed for mode-appropriate tool result formatting
export function detectModeClient(endpoint) {
  if (endpoint.includes('/v1/messages') || endpoint.includes('anthropic.com')) return 'anthropic';
  if (endpoint.includes('/api/v1/chat')) return 'lmstudio-v1';
  if (endpoint.includes('/api/v0/'))    return 'lmstudio';
  return 'openai';
}
