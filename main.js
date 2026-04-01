'use strict';

const { app, BrowserWindow, ipcMain, Menu, shell } = require('electron');
const path = require('path');
const fs   = require('fs');
const skills    = require('./skills/index');
const llm       = require('./skills/llm');
const db        = require('./skills/db');
const config    = require('./skills/config');
const mcpServer       = require('./skills/mcp-server');
const rightBrain      = require('./skills/right-brain');
const broker          = require('./skills/broker');
const claudeProxy     = require('./skills/claude-proxy');
const decayScheduler  = require('./skills/decay-scheduler');

// Port of the local MCP tool server (assigned at startup, null until ready)
let mcpPort = null;

// ─── Window state persistence ─────────────────────────────────────────────────

const STATE_FILE    = path.join(app.getPath('userData'), 'window-state.json');
const DEFAULT_STATE = { width: 1400, height: 900 };

function loadWindowState() {
  try {
    return { ...DEFAULT_STATE, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) };
  } catch {
    return DEFAULT_STATE;
  }
}

function saveWindowState(win) {
  if (win.isMinimized() || win.isMaximized()) return;
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(win.getBounds()));
  } catch { /* non-fatal */ }
}

// ─── Application menu ─────────────────────────────────────────────────────────

function buildMenu(win) {
  const isMac = process.platform === 'darwin';

  const template = [
    // macOS app menu (required as first item)
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),

    // File
    {
      label: 'File',
      submenu: [
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },

    // Edit — full clipboard + undo/redo support in text inputs
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        ...(isMac ? [
          { type: 'separator' },
          {
            label: 'Speech',
            submenu: [{ role: 'startSpeaking' }, { role: 'stopSpeaking' }],
          },
        ] : []),
      ],
    },

    // View
    {
      label: 'View',
      submenu: [
        {
          label: 'Developer Tools',
          accelerator: process.platform === 'darwin' ? 'Alt+Cmd+I' : 'Ctrl+Shift+I',
          click: () => win.webContents.toggleDevTools(),
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'forceReload' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },

    // Window
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        ...(isMac ? [
          { type: 'separator' },
          { role: 'front' },
        ] : [
          { role: 'zoom' },
        ]),
      ],
    },
  ];

  return Menu.buildFromTemplate(template);
}

// ─── Deep Dive — headless research loop (main process) ───────────────────────
// Used by the MCP/LM-Studio path where the renderer's tool loop isn't available.
// Runs llm.complete() in a loop with a read-only tool subset, returns the summary.

const DEEP_DIVE_ALLOWED_SKILLS = new Map([
  // memory
  ['memory_search',        'memory.search'],
  ['memory_save',          'memory.save'],
  ['memory_link',          'memory.link'],
  ['broker_recall',        'broker.recall'],
  ['broker_remember',      'broker.remember'],
  ['graph_recall',         'graph.recall'],
  ['working_memory_read',  'working_memory.read'],
  // web research
  ['web_search',           'web.search'],
  ['http_request',         'http.request'],
  ['reddit_search',        'reddit.search'],
  ['reddit_hot',           'reddit.hot'],
  ['reddit_post',          'reddit.post'],
  // reef reading (no posting/voting/DMing)
  ['reef_feed',            'reef.feed'],
  ['reef_feed_all',        'reef.feed_all'],
  ['reef_posts',           'reef.posts'],
  ['reef_branches',        'reef.branches'],
  ['reef_grades',          'reef.grades'],
  ['reef_profile',         'reef.profile'],
  ['reef_leaderboard',     'reef.leaderboard'],
  ['reef_documented_get',  'reefDocumented.get'],
  ['reef_documented_list', 'reefDocumented.list'],
  // file system (read-only)
  ['fs_read',              'fs.read'],
  ['fs_list',              'fs.list'],
  ['fs_exists',            'fs.exists'],
  // code exploration
  ['code_search',          'code.search'],
  ['project_scan',         'project.scan'],
  ['git_status',           'git.status'],
  ['git_diff',             'git.diff'],
  ['git_log',              'git.log'],
  // message reading (no sending)
  ['message_search',       'message.search'],
]);

// Build Anthropic-format tool schemas from MCP_TOOL_DEFS for the dive
const DEEP_DIVE_TOOL_SCHEMAS = (() => {
  const { MCP_TOOL_DEFS } = require('./skills/mcp-server');
  return MCP_TOOL_DEFS
    .filter(t => DEEP_DIVE_ALLOWED_SKILLS.has(t.name))
    .map(t => ({
      name:         t.name,
      description:  t.description,
      input_schema: t.inputSchema,
    }));
})();

const DEEP_DIVE_MAX_STEPS_HEADLESS = 20;
const DEEP_DIVE_TIMEOUT_HEADLESS   = 180_000;  // 3 minutes

async function executeDeepDiveHeadless({ goal, context, persona }) {
  if (!goal?.trim())    throw new Error('deep_dive: "goal" is required');
  if (!persona?.trim()) throw new Error('deep_dive: "persona" is required');

  const cfg = await config.load();

  // Resolve caller persona
  const DEFAULT_NAMES = { A: 'dreamer', B: 'builder', C: 'librarian' };
  const p = persona.toLowerCase();
  const caller = ['A', 'B', 'C']
    .map(id => ({ _id: id, ...(cfg[id] || {}) }))
    .find(e =>
      (e.name || '').toLowerCase()      === p ||
      DEFAULT_NAMES[e._id].toLowerCase() === p ||
      e._id.toLowerCase()               === p
    );
  if (!caller)          throw new Error(`deep_dive: persona not found: "${persona}"`);
  if (!caller.endpoint) throw new Error(`deep_dive: "${persona}" has no endpoint configured`);

  const basePrompt   = cfg.settings?.baseSystemPrompt || '';
  const entityPrompt = caller.systemPrompt            || '';
  const systemPrompt = [basePrompt, entityPrompt].filter(Boolean).join('\n\n---\n\n');

  const apiKey = caller.apiKey || cfg.global?.apiKey || '';

  // Build ephemeral conversation
  const divePrompt = [
    `[DEEP DIVE — Research Session]`,
    `You are in a focused research context. Your main conversation is paused while you investigate.`,
    ``,
    `GOAL: ${goal}`,
    context ? `\nCONTEXT: ${context}` : '',
    ``,
    `Use your tools to investigate thoroughly. When you have gathered enough, write your findings as a clear, structured summary. This summary will be returned to your main conversation.`,
    ``,
    `Be thorough but focused. Do not use conversational filler. Just research and report.`,
  ].filter(Boolean).join('\n');

  const messages = [{ role: 'user', content: divePrompt }];

  let toolCallsExecuted = 0;
  let finalText = null;

  const execDiveTool = async (toolName, toolInput) => {
    const skillName = DEEP_DIVE_ALLOWED_SKILLS.get(toolName);
    if (!skillName) throw new Error(`Tool not allowed in deep dive: ${toolName}`);

    const handler = skills.get(skillName);
    if (!handler) throw new Error(`Unknown skill: ${skillName}`);

    // Inject API keys the model can't supply
    let invokeArgs = toolInput;
    if (skillName.startsWith('reef.') && !invokeArgs.apiKey) {
      const reefKey = cfg.settings?.reefApiKey
        || cfg.A?.reefApiKey || cfg.B?.reefApiKey || cfg.C?.reefApiKey || '';
      const reefUrl = cfg.settings?.reefUrl || '';
      invokeArgs = {
        ...invokeArgs,
        ...(reefKey ? { apiKey: reefKey } : {}),
        ...(reefUrl ? { baseUrl: reefUrl } : {}),
      };
    } else if (skillName.startsWith('reefDocumented.') && !invokeArgs.apiKey) {
      const archiveKey = cfg.settings?.archiveApiKey
        || cfg.A?.reefApiKey || cfg.B?.reefApiKey || cfg.C?.reefApiKey
        || cfg.settings?.reefApiKey || '';
      const archiveUrl = cfg.settings?.archiveUrl || '';
      invokeArgs = {
        ...invokeArgs,
        ...(archiveKey ? { apiKey: archiveKey } : {}),
        ...(archiveUrl ? { baseUrl: archiveUrl } : {}),
      };
    } else if (skillName === 'web.search' && !invokeArgs.apiKey) {
      const tavilyKey = cfg.settings?.tavilyApiKey || '';
      if (tavilyKey) invokeArgs = { ...invokeArgs, apiKey: tavilyKey };
    }

    const result = await handler(invokeArgs);
    return typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  };

  const diveWork = async () => {
    for (let step = 0; step < DEEP_DIVE_MAX_STEPS_HEADLESS + 5; step++) {
      const isLastStep = toolCallsExecuted >= DEEP_DIVE_MAX_STEPS_HEADLESS;
      const toolsForCall = isLastStep ? undefined : DEEP_DIVE_TOOL_SCHEMAS;

      const result = await llm.complete({
        endpoint: caller.endpoint,
        model:    caller.model || '',
        systemPrompt,
        apiKey,
        messages,
        tools:  toolsForCall,
        store:  false,
      });

      const { text, toolUse, rawContent, mode } = result;

      // No tool calls or last step → done
      if (!toolUse?.length || isLastStep) {
        finalText = text?.trim() || null;
        return;
      }

      // Push assistant turn
      if (mode === 'anthropic') {
        messages.push({ role: 'assistant', content: rawContent });
      } else {
        messages.push({
          role: 'assistant',
          content: text ?? '',
          tool_calls: rawContent.tool_calls,
        });
      }

      // Execute tools
      toolCallsExecuted += toolUse.length;
      const toolResults = [];

      for (const tc of toolUse) {
        let resultStr;
        try {
          resultStr = await execDiveTool(tc.name, tc.input);
        } catch (err) {
          resultStr = `Error: ${err.message}`;
        }
        toolResults.push({ id: tc.id, content: resultStr });
        console.log(`[deep_dive] ${tc.name} → ${resultStr.length} chars`);
      }

      // Push tool results
      if (mode === 'anthropic') {
        messages.push({
          role: 'user',
          content: toolResults.map(r => ({
            type: 'tool_result',
            tool_use_id: r.id,
            content: r.content,
          })),
        });
      } else {
        for (const r of toolResults) {
          messages.push({ role: 'tool', tool_call_id: r.id, content: r.content });
        }
      }
    }
  };

  // Race against timeout
  try {
    await Promise.race([
      diveWork(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Deep dive timed out after 180s')),
          DEEP_DIVE_TIMEOUT_HEADLESS)
      ),
    ]);
  } catch (err) {
    console.error('[deep_dive]', err.message);
    return `Deep dive error: ${err.message}`;
  }

  console.log(`[deep_dive] Surfaced after ${toolCallsExecuted} tool calls`);

  if (!finalText) {
    return `Deep dive completed ${toolCallsExecuted} tool calls but produced no summary. The research may still have saved memories.`;
  }

  return finalText;
}

// ─── Window creation ──────────────────────────────────────────────────────────

let mainWindow;

function createWindow() {
  const state = loadWindowState();

  // Resolve icon path — falls back gracefully if the file doesn't exist yet
  const iconBase = path.join(__dirname, 'assets', 'icon');
  let iconPath;
  if (process.platform === 'win32')       iconPath = iconBase + '.ico';
  else if (process.platform === 'darwin') iconPath = iconBase + '.icns';
  else                                    iconPath = iconBase + '.png';
  const iconExists = fs.existsSync(iconPath);

  mainWindow = new BrowserWindow({
    width:   state.width  ?? DEFAULT_STATE.width,
    height:  state.height ?? DEFAULT_STATE.height,
    x:       state.x,
    y:       state.y,
    minWidth:  900,
    minHeight: 600,
    backgroundColor: '#050810',
    ...(iconExists ? { icon: iconPath } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    titleBarStyle: 'default',
    title: 'The Reef — Colony Interface',
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Apply custom menu
  const menu = buildMenu(mainWindow);
  Menu.setApplicationMenu(menu);

  // Persist state on close
  mainWindow.on('close',  () => saveWindowState(mainWindow));
  mainWindow.on('resize', () => saveWindowState(mainWindow));
  mainWindow.on('move',   () => saveWindowState(mainWindow));
}

// ─── App lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  // ── Database ─────────────────────────────────────────────────────────────────
  try {
    await db.init();
  } catch (err) {
    console.error('[main] DB init failed — memory system unavailable:', err.message);
  }

  // ── Claude CLI OAuth proxy ────────────────────────────────────────────────────
  // Starts a loopback HTTP server that reads ~/.claude/.credentials.json and
  // proxies POST /v1/messages to api.anthropic.com using the OAuth token.
  // Personas configured with endpoint = claudeProxy.endpoint() get free-tier
  // inference through your Claude subscription instead of API billing.
  try {
    await claudeProxy.start();
    const status = claudeProxy.credentialStatus();
    if (status.ok) {
      console.log('[main] Claude proxy ready:', claudeProxy.endpoint());
    } else {
      console.warn('[main] Claude proxy started but credentials unavailable:', status.message);
    }
  } catch (err) {
    console.error('[main] Claude proxy failed to start:', err.message);
  }

  // ── Broker source registry + trust weights ───────────────────────────────────
  // Seeds personas into lb_sources, then loads weights into the in-memory cache.
  broker.seedSources()
    .then(() => broker.trust.load())
    .catch(err => {
      console.error('[main] broker seedSources/trust.load failed:', err.message);
    });

  // ── Right-brain graph memory ──────────────────────────────────────────────────
  // Async — model download (~80MB on first run) happens here.
  // Skills return errors until ready; app continues regardless.
  rightBrain.init({
    dbPath:   path.join(app.getPath('userData'), 'right-brain.db'),
    cacheDir: path.join(app.getPath('userData'), '.transformers-cache'),
  }).catch(err => {
    console.error('[main] right-brain init failed — graph memory unavailable:', err.message);
  });

  // ── Decay scheduler ───────────────────────────────────────────────────────────
  // Starts the self-rescheduling maintenance loop (6-hour default interval).
  // Also exposed as graph.runDecayPass skill for manual Librarian-triggered passes.
  decayScheduler.start({ intervalMs: 6 * 60 * 60 * 1000, pruneThreshold: 0.1 });

  // ── MCP tool server ───────────────────────────────────────────────────────────
  // Starts a local JSON-RPC 2.0 HTTP server that exposes our built-in skills to
  // LM Studio v1 via the `integrations.ephemeral_mcp` mechanism.  The OS picks a
  // random free port; the renderer reads it via the `mcp:port` IPC channel.
  try {
    const { port } = await mcpServer.createMcpServer({
      execSkill: async (skillName, args) => {
        // ── colony_ask: direct ephemeral LLM call to the target persona ──────
        // Runs entirely in the main process — no renderer IPC needed.
        // Uses store:false so it never pollutes the target's LM Studio history.
        if (skillName === 'colony_ask') {
          const cfg = await config.load();
          const { to, message } = args;
          if (!to)      throw new Error('colony_ask: "to" is required');
          if (!message) throw new Error('colony_ask: "message" is required');

          // Default names let callers use 'dreamer'/'builder'/'librarian' even if
          // the persona's display name hasn't been customised in config.
          const DEFAULT_NAMES = { A: 'dreamer', B: 'builder', C: 'librarian' };
          const t = to.toLowerCase();
          const target = ['A', 'B', 'C']
            .map(id => ({ _id: id, ...(cfg[id] || {}) }))
            .find(p =>
              (p.name || '').toLowerCase()      === t ||
              DEFAULT_NAMES[p._id].toLowerCase() === t ||
              p._id.toLowerCase()               === t
            );
          if (!target)          throw new Error(`Colony member not found: "${to}"`);
          if (!target.endpoint) throw new Error(`"${to}" has no endpoint configured`);

          const basePrompt   = cfg.settings?.baseSystemPrompt || '';
          const entityPrompt = target.systemPrompt            || '';
          const systemPrompt = [basePrompt, entityPrompt].filter(Boolean).join('\n\n---\n\n');

          const result = await llm.complete({
            endpoint:    target.endpoint,
            model:       target.model  || '',
            systemPrompt,
            apiKey:      target.apiKey || cfg.global?.apiKey || '',
            messages:    [{ role: 'user', content: String(message) }],
            store: false,   // ephemeral — no conversation state side-effects
          });

          const name = target.name || to;
          return `[${name}]: ${result.text || '[no response]'}`;
        }

        // ── deep_dive: headless multi-step research loop ──────────────────────
        if (skillName === 'deep_dive') {
          return await executeDeepDiveHeadless(args);
        }

        const handler = skills.get(skillName);
        if (!handler) throw new Error(`Unknown skill: ${skillName}`);

        // Reef skills need an API key + base URL that the LLM can't supply itself.
        // Inject them from the saved config so the MCP/LM-Studio-v1 path works.
        // MCP calls carry no persona context, so we cascade: global settings key
        // first, then any per-entity key (all entities share the same reef instance
        // in practice, so the first non-empty one is the right one).
        let invokeArgs = args;
        if (skillName.startsWith('reef.') && !invokeArgs.apiKey) {
          const cfg = await config.load();
          const reefKey = cfg?.settings?.reefApiKey
            || cfg?.A?.reefApiKey || cfg?.B?.reefApiKey || cfg?.C?.reefApiKey
            || '';
          const reefUrl = cfg?.settings?.reefUrl || '';
          invokeArgs = {
            ...invokeArgs,
            ...(reefKey ? { apiKey:   reefKey } : {}),
            ...(reefUrl ? { baseUrl:  reefUrl } : {}),
          };
        }

        if (skillName.startsWith('reefDocumented.') && !invokeArgs.apiKey) {
          const cfg = await config.load();
          const archiveKey = cfg?.settings?.archiveApiKey
            || cfg?.A?.reefApiKey || cfg?.B?.reefApiKey || cfg?.C?.reefApiKey
            || cfg?.settings?.reefApiKey
            || '';
          const archiveUrl = cfg?.settings?.archiveUrl || '';
          invokeArgs = {
            ...invokeArgs,
            ...(archiveKey ? { apiKey:  archiveKey } : {}),
            ...(archiveUrl ? { baseUrl: archiveUrl } : {}),
          };
        }

        // web.search — inject Tavily key from settings (never sent by the model)
        if (skillName === 'web.search' && !invokeArgs.apiKey) {
          const cfg = await config.load();
          const tavilyKey = cfg?.settings?.tavilyApiKey || '';
          if (tavilyKey) invokeArgs = { ...invokeArgs, apiKey: tavilyKey };
        }

        // Pass a live ctx so requestConfirm and mainWindow are always current
        return await handler(invokeArgs, { get mainWindow() { return mainWindow; }, requestConfirm });
      },
    });
    mcpPort = port;
  } catch (err) {
    console.error('[main] MCP server failed to start:', err.message);
  }

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // ── Reef dweller roster sync ────────────────────────────────────────────────
  // On startup, if a Reef API key is configured, sync the colony's dweller
  // roster so agents can post using their persona names.
  (async () => {
    try {
      const cfg = await config.load();
      const reefKey = cfg?.settings?.reefApiKey;
      const reefUrl = cfg?.settings?.reefUrl || '';
      if (!reefKey) return;

      const DEFAULT_NAMES = { A: 'Dreamer', B: 'Builder', C: 'Librarian' };
      const dwellers = ['A', 'B', 'C'].map(id => ({
        persona_id: id,
        name: cfg[id]?.name || DEFAULT_NAMES[id],
        role: cfg[id]?.systemPrompt?.split('\n')[0]?.slice(0, 100) || '',
      }));

      const reef = require('./skills/reef');
      await reef.syncDwellers({
        dwellers,
        apiKey: reefKey,
        ...(reefUrl ? { baseUrl: reefUrl } : {}),
      });
      console.log('[main] Reef dweller roster synced:', dwellers.map(d => d.name).join(', '));
    } catch (err) {
      console.log('[main] Reef dweller sync skipped:', err.message);
    }
  })();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  decayScheduler.stop();
  claudeProxy.stop();
});

// ─── IPC: skill router ────────────────────────────────────────────────────────

ipcMain.handle('skill:run', async (_event, skillName, args) => {
  const handler = skills.get(skillName);
  if (!handler) {
    return { ok: false, error: `Unknown skill: ${skillName}` };
  }
  try {
    const result = await handler(args, { mainWindow, requestConfirm });
    // After a successful config save, broadcast the new config to all windows
    // so each can apply any side-effects (font scale, colony name, heartbeat, etc.)
    if (skillName === 'config.save') {
      BrowserWindow.getAllWindows().forEach(win => {
        if (!win.isDestroyed()) win.webContents.send('config:updated', args);
      });
    }
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ─── IPC: MCP port ────────────────────────────────────────────────────────────
// Renderer queries this once on startup to know where the local MCP server is.

ipcMain.handle('mcp:port', () => mcpPort);

// ─── IPC: Claude CLI proxy info ───────────────────────────────────────────────
// Returns { endpoint, status } so the renderer can resolve "claude-cli" sentinels
// and show credential health in the UI.

ipcMain.handle('claude-proxy:info', () => ({
  endpoint: claudeProxy.endpoint(),
  status:   claudeProxy.credentialStatus(),
}));

// ─── IPC: Inspector windows ───────────────────────────────────────────────────
// Opens a standalone BrowserWindow for memory browser, messages, or archive.
// Each window reuses the same preload.js so it has full skill access via IPC.

ipcMain.handle('window:open', (_event, type) => {
  const configs = {
    'memory-browser': { width: 1100, height: 750, title: 'THE REEF — MEMORY BROWSER' },
    'messages':       { width:  960, height: 700, title: 'THE REEF — COLONY MESSAGES' },
    'archive':        { width:  960, height: 650, title: 'THE REEF — ARCHIVE'         },
    'votes':          { width:  960, height: 700, title: 'THE REEF — GOVERNANCE'     },
    'dreams':         { width: 1100, height: 750, title: 'THE REEF — DREAMS'        },
    'reef-network':   { width: 1100, height: 800, title: 'THE REEF — SOCIAL NETWORK'  },
    'settings':       { width:  820, height: 640, title: 'THE REEF — SETTINGS'        },
    'visualizer':     { width: 1280, height: 820, title: 'THE REEF — MEMORY GRAPH'    },
  };
  const cfg = configs[type];
  if (!cfg) return { ok: false, error: `Unknown window type: ${type}` };

  const win = new BrowserWindow({
    width:  cfg.width,
    height: cfg.height,
    minWidth:  640,
    minHeight: 400,
    backgroundColor: '#050810',
    title: cfg.title,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenu(null);
  win.loadFile(path.join(__dirname, 'renderer', `${type}.html`));
  return { ok: true };
});

// ─── IPC: streaming LLM ───────────────────────────────────────────────────────
// Starts an SSE stream for the given args.  Pushes normalised chunk events to
// the requesting window via 'llm:stream:event' while the stream is running,
// then resolves the invoke with the final unified result (or an error object).
//
// The renderer registers a listener for 'llm:stream:event' before calling this
// handler so it can process live chunks while awaiting the invoke result.
// Active stream promises are tracked so the renderer can abort them mid-flight.

const activeStreamRegistry = new Map();  // streamId → promise with .abort()

ipcMain.handle('llm:stream:start', async (event, streamId, args) => {
  try {
    const promise = llm.stream(args, (chunk) => {
      // Guard: window may have been closed before the stream finishes
      if (!event.sender.isDestroyed()) {
        event.sender.send('llm:stream:event', streamId, chunk);
      }
    });
    activeStreamRegistry.set(streamId, promise);
    const result = await promise;
    activeStreamRegistry.delete(streamId);
    return { ok: true, result };
  } catch (err) {
    activeStreamRegistry.delete(streamId);
    // Destroyed/aborted connections produce ECONNRESET or 'aborted' — treat as
    // a clean stop rather than a hard error so the renderer doesn't show a red bubble.
    const isAbort = /aborted|ECONNRESET|ECONNABORTED/i.test(err.message || '');
    if (isAbort) return { ok: false, error: null, aborted: true };
    return { ok: false, error: err.message };
  }
});

// Renderer calls this to kill an in-flight stream immediately.
ipcMain.handle('llm:stream:abort', (_event, streamId) => {
  const promise = activeStreamRegistry.get(streamId);
  if (promise?.abort) {
    promise.abort('interrupted');
    activeStreamRegistry.delete(streamId);
  }
  return { ok: true };
});

// ─── IPC: confirmation bridge ─────────────────────────────────────────────────

const pendingConfirms = new Map();

ipcMain.handle('confirm:response', (_event, id, approved) => {
  const resolve = pendingConfirms.get(id);
  if (resolve) {
    pendingConfirms.delete(id);
    resolve(approved);
  }
});

function requestConfirm(message) {
  return new Promise((resolve) => {
    const id = `confirm_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    pendingConfirms.set(id, resolve);
    mainWindow.webContents.send('confirm:request', id, message);
  });
}

module.exports = { requestConfirm };
