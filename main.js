'use strict';

const { app, BrowserWindow, ipcMain, Menu, shell } = require('electron');
const path = require('path');
const fs   = require('fs');
const skills    = require('./skills/index');
const llm       = require('./skills/llm');
const db        = require('./skills/db');
const config    = require('./skills/config');
const mcpServer  = require('./skills/mcp-server');
const rightBrain = require('./skills/right-brain');
const broker     = require('./skills/broker');

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
          const reefKey = cfg?.A?.reefApiKey || cfg?.B?.reefApiKey || cfg?.C?.reefApiKey
            || cfg?.settings?.reefApiKey
            || '';
          const reefUrl = cfg?.settings?.reefUrl || '';
          invokeArgs = {
            ...invokeArgs,
            ...(reefKey ? { apiKey:   reefKey } : {}),
            ...(reefUrl ? { baseUrl:  reefUrl } : {}),
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
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
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

// ─── IPC: Inspector windows ───────────────────────────────────────────────────
// Opens a standalone BrowserWindow for memory browser, messages, or archive.
// Each window reuses the same preload.js so it has full skill access via IPC.

ipcMain.handle('window:open', (_event, type) => {
  const configs = {
    'memory-browser': { width: 1100, height: 750, title: 'THE REEF — MEMORY BROWSER' },
    'messages':       { width:  960, height: 700, title: 'THE REEF — COLONY MESSAGES' },
    'archive':        { width:  960, height: 650, title: 'THE REEF — ARCHIVE'         },
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

ipcMain.handle('llm:stream:start', async (event, streamId, args) => {
  try {
    const result = await llm.stream(args, (chunk) => {
      // Guard: window may have been closed before the stream finishes
      if (!event.sender.isDestroyed()) {
        event.sender.send('llm:stream:event', streamId, chunk);
      }
    });
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: err.message };
  }
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
