#!/usr/bin/env node
'use strict';

/**
 * export-keys.js — One-time helper to export encrypted config keys
 * as plaintext for headless MCP server access.
 *
 * Run this ONCE after setting keys in the Electron app settings.
 * After that, the Electron app will auto-export on every save.
 *
 * Usage: node scripts/export-keys.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// Try to load Electron's safeStorage for decryption
let safeStorage;
try {
  const electron = require('electron');
  safeStorage = electron.safeStorage;
} catch {
  // Not running in Electron — try to decrypt manually
  safeStorage = null;
}

const SENSITIVE_PATHS = [
  'settings.reefApiKey',
  'settings.archiveApiKey',
  'settings.tavilyApiKey',
  'global.apiKey',
  'A.apiKey',    'A.reefApiKey',
  'B.apiKey',    'B.reefApiKey',
  'C.apiKey',    'C.reefApiKey',
  'database.password',
];

function _get(obj, keyPath) {
  return keyPath.split('.').reduce((o, k) => (o != null ? o[k] : undefined), obj);
}

function _set(obj, keyPath, value) {
  const parts = keyPath.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

const userDataDir = path.join(os.homedir(), 'AppData', 'Roaming', 'the-reef');
const configFile = path.join(userDataDir, 'reef-config.json');
const keysFile = path.join(userDataDir, 'reef-keys.json');

if (!fs.existsSync(configFile)) {
  console.error('Config file not found:', configFile);
  console.error('Open the Electron app and save settings first.');
  process.exit(1);
}

console.log('Reading:', configFile);

// Prompt for manual key entry since we can't decrypt DPAPI outside Electron
console.log('\nEncrypted keys found in config. Since DPAPI decryption requires');
console.log('the Electron app, please enter your keys manually:\n');

const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask(prompt) {
  return new Promise(resolve => rl.question(prompt, resolve));
}

(async () => {
  const keys = {};

  const reefKey = await ask('Reef API Key (reef_xxx): ');
  if (reefKey.trim()) _set(keys, 'settings.reefApiKey', reefKey.trim());

  const reefUrl = await ask('Reef URL (leave blank for http://localhost:3000): ');
  if (reefUrl.trim()) _set(keys, 'settings.reefUrl', reefUrl.trim());

  const archiveKey = await ask('Archive API Key (leave blank to use Reef key): ');
  if (archiveKey.trim()) _set(keys, 'settings.archiveApiKey', archiveKey.trim());

  const tavilyKey = await ask('Tavily API Key (leave blank to skip): ');
  if (tavilyKey.trim()) _set(keys, 'settings.tavilyApiKey', tavilyKey.trim());

  rl.close();

  fs.writeFileSync(keysFile, JSON.stringify(keys, null, 2), 'utf8');
  console.log('\nKeys exported to:', keysFile);
  console.log('The MCP stdio server will now pick these up automatically.');
})();
