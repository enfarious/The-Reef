'use strict';

const { app, BrowserWindow, ipcMain, Menu, shell } = require('electron');
const path = require('path');
const fs   = require('fs');
const skills = require('./skills/index');
const db = require('./skills/db');

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
  try {
    await db.init();
  } catch (err) {
    console.error('[main] DB init failed — memory system unavailable:', err.message);
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
