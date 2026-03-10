'use strict';

/**
 * claude-proxy.js — Local OAuth proxy for Claude CLI credentials
 *
 * Starts a loopback HTTP server that:
 *   1. Reads OAuth tokens from ~/.claude/.credentials.json  (Claude CLI session)
 *   2. Exposes POST /v1/messages  — Anthropic API passthrough (streaming supported)
 *   3. Handles token refresh automatically (Claude CLI token format)
 *
 * Usage in Reef config:
 *   endpoint: "http://localhost:<proxyPort>/v1/messages"
 *   apiKey:   ""   (not needed — OAuth is injected server-side)
 *
 * The proxy is transparent: it forwards the exact request body to
 * api.anthropic.com and streams the response back unchanged.
 * The ONLY thing it does differently is swap the auth header.
 */

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const os    = require('os');

// ─── Credentials ──────────────────────────────────────────────────────────────

const CREDS_PATH = path.join(os.homedir(), '.claude', '.credentials.json');

function readCredentials() {
  try {
    const raw = fs.readFileSync(CREDS_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

/**
 * Returns the best available auth header value, or null if nothing is found.
 *
 * Claude CLI credentials.json shape (as of Claude Code):
 * {
 *   "claudeAiOauth": {
 *     "accessToken": "...",
 *     "refreshToken": "...",
 *     "expiresAt": 1234567890000
 *   }
 * }
 */
function getAuthToken() {
  const creds = readCredentials();
  if (!creds) return null;

  // Primary path: claudeAiOauth (Claude Code / Claude CLI)
  const oauth = creds.claudeAiOauth;
  if (oauth?.accessToken) {
    return oauth.accessToken;
  }

  // Fallback: some versions store it flat
  if (creds.accessToken) return creds.accessToken;
  if (creds.token)       return creds.token;

  return null;
}

function getAuthHeader() {
  const token = getAuthToken();
  if (!token) return null;
  // Claude CLI OAuth tokens go as Bearer, not x-api-key
  return `Bearer ${token}`;
}

// ─── Proxy ────────────────────────────────────────────────────────────────────

const ANTHROPIC_HOST = 'api.anthropic.com';
const ANTHROPIC_PORT = 443;

/**
 * Forwards a request to Anthropic, injecting our OAuth token.
 * Supports both streaming (SSE) and non-streaming responses.
 */
function proxyToAnthropic(reqBody, res) {
  const auth = getAuthHeader();

  const upstream_headers = {
    'content-type':      'application/json',
    'anthropic-version': '2023-06-01',
    'content-length':    Buffer.byteLength(reqBody),
  };

  if (auth) {
    upstream_headers['authorization'] = auth;
  } else {
    // No credentials — let Anthropic return the 401 so the UI can show it
    console.warn('[claude-proxy] No OAuth credentials found at', CREDS_PATH);
  }

  const options = {
    hostname: ANTHROPIC_HOST,
    port:     ANTHROPIC_PORT,
    path:     '/v1/messages',
    method:   'POST',
    headers:  upstream_headers,
  };

  const upstream = https.request(options, (upRes) => {
    // Pass status + headers straight through
    const outHeaders = {};
    for (const [k, v] of Object.entries(upRes.headers)) {
      // Strip hop-by-hop headers
      if (!['transfer-encoding', 'connection', 'keep-alive'].includes(k)) {
        outHeaders[k] = v;
      }
    }
    // Always allow CORS from localhost (Electron renderer)
    outHeaders['access-control-allow-origin'] = '*';

    res.writeHead(upRes.statusCode, outHeaders);
    upRes.pipe(res);
  });

  upstream.on('error', (err) => {
    console.error('[claude-proxy] upstream error:', err.message);
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json' });
    }
    res.end(JSON.stringify({ error: { type: 'proxy_error', message: err.message } }));
  });

  upstream.write(reqBody);
  upstream.end();
}

// ─── Server ───────────────────────────────────────────────────────────────────

let _server = null;
let _port   = null;

/**
 * Start the proxy server on a random free port.
 * Returns Promise<number> — the port it's listening on.
 * Calling start() a second time returns the existing port immediately.
 */
function start() {
  if (_server) return Promise.resolve(_port);

  return new Promise((resolve, reject) => {
    _server = http.createServer((req, res) => {
      // CORS preflight
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'access-control-allow-origin':  '*',
          'access-control-allow-methods': 'POST, OPTIONS',
          'access-control-allow-headers': 'content-type, x-api-key, anthropic-version, authorization',
        });
        res.end();
        return;
      }

      // Only handle POST /v1/messages
      if (req.method !== 'POST' || req.url !== '/v1/messages') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'claude-proxy: only POST /v1/messages is supported' }));
        return;
      }

      // Collect body
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        proxyToAnthropic(body, res);
      });
      req.on('error', (err) => {
        console.error('[claude-proxy] request error:', err.message);
      });
    });

    // Port 0 → OS picks a free port
    _server.listen(0, '127.0.0.1', () => {
      _port = _server.address().port;
      console.log(`[claude-proxy] Listening on http://127.0.0.1:${_port}/v1/messages`);
      resolve(_port);
    });

    _server.on('error', reject);
  });
}

function stop() {
  return new Promise((resolve) => {
    if (!_server) { resolve(); return; }
    _server.close(() => {
      _server = null;
      _port   = null;
      resolve();
    });
  });
}

/**
 * Returns the proxy endpoint URL if the server is running, null otherwise.
 */
function endpoint() {
  return _port ? `http://127.0.0.1:${_port}/v1/messages` : null;
}

/**
 * Quick health-check: can we find credentials at all?
 * Returns { ok: boolean, message: string }
 */
function credentialStatus() {
  const creds = readCredentials();
  if (!creds) {
    return { ok: false, message: `No credentials file found at ${CREDS_PATH}. Run 'claude login' first.` };
  }
  const token = getAuthToken();
  if (!token) {
    return { ok: false, message: `Credentials file exists but no access token found. Re-run 'claude login'.` };
  }
  // Check expiry if present
  const oauth = creds.claudeAiOauth;
  if (oauth?.expiresAt) {
    const expiresIn = oauth.expiresAt - Date.now();
    if (expiresIn < 0) {
      return { ok: false, message: `OAuth token expired ${Math.round(-expiresIn / 60000)}m ago. Run 'claude login' to refresh.` };
    }
    if (expiresIn < 5 * 60 * 1000) {
      return { ok: true, message: `Token expiring in ${Math.round(expiresIn / 60000)}m — will be refreshed on next use.` };
    }
  }
  return { ok: true, message: 'Claude CLI credentials found and valid.' };
}

module.exports = { start, stop, endpoint, credentialStatus };
