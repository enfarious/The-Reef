'use strict';

const fs     = require('fs');
const fsp    = require('fs').promises;
const path   = require('path');
const { dialog } = require('electron');

// ─── fs.read ─────────────────────────────────────────────────────────────────
// Read a file and return its text contents.

async function read({ path: filePath }) {
  if (!filePath) throw new Error('path is required');
  return fsp.readFile(filePath, 'utf8');
}

// ─── fs.write ────────────────────────────────────────────────────────────────
// Write content to a file.  If the file already exists, the user must confirm
// before it is overwritten.

async function write({ path: filePath, content }, ctx) {
  if (!filePath) throw new Error('path is required');

  const exists = fs.existsSync(filePath);
  if (exists) {
    const approved = await ctx.requestConfirm(
      `Overwrite existing file?\n\n${filePath}`
    );
    if (!approved) return { written: false, reason: 'cancelled' };
  }

  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, content ?? '', 'utf8');
  return { written: true, path: filePath };
}

// ─── fs.delete ───────────────────────────────────────────────────────────────
// Delete a file.  Always requires explicit user confirmation.

async function remove({ path: filePath }, ctx) {
  if (!filePath) throw new Error('path is required');

  const approved = await ctx.requestConfirm(
    `Permanently delete this file?\n\n${filePath}\n\nThis cannot be undone.`
  );
  if (!approved) return { deleted: false, reason: 'cancelled' };

  await fsp.unlink(filePath);
  return { deleted: true, path: filePath };
}

// ─── fs.list ─────────────────────────────────────────────────────────────────
// List directory contents.  Returns an array of { name, type, path } entries.

async function list({ path: dirPath }) {
  if (!dirPath) throw new Error('path is required');
  const entries = await fsp.readdir(dirPath, { withFileTypes: true });
  return entries.map(e => ({
    name: e.name,
    type: e.isDirectory() ? 'dir' : 'file',
    path: path.join(dirPath, e.name),
  }));
}

// ─── fs.exists ───────────────────────────────────────────────────────────────
// Returns true if path exists, false otherwise.

async function exists({ path: filePath }) {
  if (!filePath) throw new Error('path is required');
  return fs.existsSync(filePath);
}

// ─── fs.pickFile ─────────────────────────────────────────────────────────────
// Open a native file-picker dialog.  Returns the chosen path or null if
// cancelled.  `filters` is an Electron FileFilter array, e.g.:
//   [{ name: 'Text', extensions: ['txt', 'md'] }]

async function pickFile({ filters = [], title = 'Open File' } = {}, ctx) {
  const result = await dialog.showOpenDialog(ctx.mainWindow, {
    title,
    properties: ['openFile'],
    filters,
  });
  return result.canceled ? null : result.filePaths[0];
}

// ─── fs.pickDir ──────────────────────────────────────────────────────────────
// Open a native folder-picker dialog.  Returns the chosen path or null.

async function pickDir({ title = 'Open Folder' } = {}, ctx) {
  const result = await dialog.showOpenDialog(ctx.mainWindow, {
    title,
    properties: ['openDirectory'],
  });
  return result.canceled ? null : result.filePaths[0];
}

module.exports = { read, write, remove, list, exists, pickFile, pickDir };
