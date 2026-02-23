'use strict';

const { clipboard } = require('electron');

// ─── clipboard.read ───────────────────────────────────────────────────────────
// Returns the current clipboard text contents.

async function read() {
  return clipboard.readText();
}

// ─── clipboard.write ─────────────────────────────────────────────────────────
// Writes text to the clipboard. Returns true on success.

async function write({ text }) {
  clipboard.writeText(String(text ?? ''));
  return true;
}

module.exports = { read, write };
