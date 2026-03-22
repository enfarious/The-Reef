'use strict';

const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');

function configPath() {
  return path.join(app.getPath('userData'), 'reef-config.json');
}

// ─── Sensitive field paths ─────────────────────────────────────────────────────
// These values are encrypted at rest using the OS keychain (Windows DPAPI,
// macOS Keychain, Linux libsecret).  Stored with an 'enc:' prefix so unencrypted
// legacy values and missing fields pass through unchanged.

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

function _encrypt(value) {
  if (typeof value !== 'string' || value === '') return value;
  if (value.startsWith('enc:')) return value; // already encrypted
  if (!safeStorage.isEncryptionAvailable()) return value;
  try {
    return 'enc:' + safeStorage.encryptString(value).toString('base64');
  } catch { return value; }
}

function _decrypt(value) {
  if (typeof value !== 'string' || !value.startsWith('enc:')) return value;
  if (!safeStorage.isEncryptionAvailable()) return value;
  try {
    return safeStorage.decryptString(Buffer.from(value.slice(4), 'base64'));
  } catch { return value; }
}

function _transform(data, fn) {
  const result = JSON.parse(JSON.stringify(data));
  for (const p of SENSITIVE_PATHS) {
    const v = _get(result, p);
    if (typeof v === 'string' && v !== '') _set(result, p, fn(v));
  }
  return result;
}

// ─── Public API ────────────────────────────────────────────────────────────────

// Path for plaintext key export (readable by headless MCP server)
function keysPath() {
  return path.join(app.getPath('userData'), 'reef-keys.json');
}

// Export just the sensitive values as plaintext for headless consumers
function _exportKeys(data) {
  const keys = {};
  for (const p of SENSITIVE_PATHS) {
    const v = _get(data, p);
    if (typeof v === 'string' && v !== '') _set(keys, p, v);
  }
  return keys;
}

async function save(data) {
  const p = configPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const encrypted = _transform(data, _encrypt);
  fs.writeFileSync(p, JSON.stringify(encrypted, null, 2), 'utf8');

  // Write plaintext keys for headless MCP server access
  try {
    fs.writeFileSync(keysPath(), JSON.stringify(_exportKeys(data), null, 2), 'utf8');
  } catch { /* non-fatal */ }

  return true;
}

async function load() {
  const p = configPath();
  if (!fs.existsSync(p)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    const decrypted = _transform(raw, _decrypt);

    // If decryption isn't available (headless), overlay plaintext keys
    if (!safeStorage.isEncryptionAvailable()) {
      try {
        const kp = keysPath();
        if (fs.existsSync(kp)) {
          const keys = JSON.parse(fs.readFileSync(kp, 'utf8'));
          for (const sp of SENSITIVE_PATHS) {
            const v = _get(keys, sp);
            if (typeof v === 'string' && v !== '') _set(decrypted, sp, v);
          }
        }
      } catch { /* use whatever we have */ }
    }

    return decrypted;
  } catch {
    return null;
  }
}

module.exports = { save, load };
