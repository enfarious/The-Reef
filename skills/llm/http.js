'use strict';

const https = require('https');
const http  = require('http');

// ─── HTTP helpers (Node, no CORS) ─────────────────────────────────────────────

function httpRequest(url, method, headers, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const payload = body ? JSON.stringify(body) : null;

    const opts = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method,
      headers: { ...headers },
    };

    if (payload) {
      opts.headers['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = lib.request(opts, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode >= 400) {
            reject(new Error(json.error?.message || json.message || `HTTP ${res.statusCode}`));
          } else {
            resolve(json);
          }
        } catch {
          reject(new Error(`Invalid JSON response: ${data.slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const fetchJson    = (url, headers, body) => httpRequest(url, 'POST', headers, body);
const fetchJsonGet = (url, headers)       => httpRequest(url, 'GET',  headers, null);

// ─── SSE streaming helper ─────────────────────────────────────────────────────
// Sends a POST request and delivers Server-Sent Events to callbacks.
// onEvent(eventType, parsedData) — called for each SSE data line
// onEnd()   — called when the stream closes cleanly
// onError(err) — called on network/HTTP errors
// Returns the raw http.ClientRequest so the caller can abort if needed.

function httpStream(url, headers, body, { onEvent, onEnd, onError }) {
  const parsed  = new URL(url);
  const lib     = parsed.protocol === 'https:' ? https : http;
  const payload = JSON.stringify(body);

  const opts = {
    hostname: parsed.hostname,
    port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
    path:     parsed.pathname + parsed.search,
    method:   'POST',
    headers: {
      ...headers,
      'Content-Type':   'application/json',
      'Accept':         'text/event-stream',
      'Cache-Control':  'no-cache',
      'Content-Length': Buffer.byteLength(payload),
    },
  };

  let finished = false;

  const req = lib.request(opts, (res) => {
    if (res.statusCode >= 400) {
      let errBody = '';
      res.on('data', c => { errBody += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(errBody);
          onError(new Error(j.error?.message || j.message || `HTTP ${res.statusCode}`));
        } catch {
          onError(new Error(`HTTP ${res.statusCode}: ${errBody.slice(0, 200)}`));
        }
      });
      return;
    }

    let buf       = '';
    let eventType = '';

    res.on('data', chunk => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';   // last incomplete line back to buffer

      for (const raw of lines) {
        const line = raw.trimEnd();
        if (line.startsWith('event:')) {
          eventType = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          const text = line.slice(5).trim();
          if (text === '[DONE]') {
            if (!finished) { finished = true; onEnd(); }
            return;
          }
          try { onEvent(eventType || 'data', JSON.parse(text)); } catch { /* ignore malformed */ }
          eventType = '';
        } else if (line === '') {
          eventType = '';   // blank line resets event type
        }
      }
    });

    res.on('end', () => { if (!finished) { finished = true; onEnd(); } });
  });

  req.on('error', (err) => { if (!finished) { finished = true; onError(err); } });
  req.write(payload);
  req.end();
  return req;
}

module.exports = { httpRequest, fetchJson, fetchJsonGet, httpStream };
