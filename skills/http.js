'use strict';

const https = require('https');
const http  = require('http');

// ─── General HTTP/API skill ──────────────────────────────────────────────────
// Lets entities make arbitrary HTTP requests to interact with APIs, webhooks,
// or web services.  Supports GET, POST, PUT, PATCH, DELETE with JSON or
// plain-text bodies.  Follows redirects (one level).

const USER_AGENT = 'TheReefColony/1.0 (Electron; multi-agent AI interface)';
const TIMEOUT    = 30_000;
const MAX_BODY   = 256 * 1024;  // 256 KB response cap

function request({ url: urlStr, method = 'GET', headers = {}, body, timeout } = {}) {
  if (!urlStr) throw new Error('url is required.');

  return new Promise((resolve, reject) => {
    const url  = new URL(urlStr);
    const mod  = url.protocol === 'https:' ? https : http;
    const ms   = Math.min(Math.max(1000, Number(timeout) || TIMEOUT), 60_000);

    const reqHeaders = {
      'User-Agent': USER_AGENT,
      ...headers,
    };

    // Auto-set content-type for object bodies
    let payload = null;
    if (body != null) {
      if (typeof body === 'object') {
        payload = JSON.stringify(body);
        if (!reqHeaders['Content-Type'] && !reqHeaders['content-type']) {
          reqHeaders['Content-Type'] = 'application/json';
        }
      } else {
        payload = String(body);
      }
      reqHeaders['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = mod.request(
      {
        hostname: url.hostname,
        port:     url.port || undefined,
        path:     url.pathname + url.search,
        method:   method.toUpperCase(),
        headers:  reqHeaders,
        timeout:  ms,
      },
      (res) => {
        // Follow one redirect
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return request({
            url: res.headers.location, method, headers, body, timeout,
          }).then(resolve, reject);
        }

        let chunks = [];
        let size   = 0;

        res.on('data', chunk => {
          size += chunk.length;
          if (size <= MAX_BODY) chunks.push(chunk);
        });

        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          const truncated = size > MAX_BODY;

          // Try to parse as JSON
          let data = raw;
          const ct = res.headers['content-type'] || '';
          if (ct.includes('json')) {
            try { data = JSON.parse(raw); } catch { /* keep as string */ }
          }

          resolve({
            status:  res.statusCode,
            headers: res.headers,
            body:    data,
            ...(truncated ? { truncated: true, totalBytes: size } : {}),
          });
        });
      },
    );

    req.on('error', e => reject(new Error(`HTTP request failed: ${e.message}`)));
    req.on('timeout', () => { req.destroy(); reject(new Error('HTTP request timed out.')); });

    if (payload) req.write(payload);
    req.end();
  });
}

module.exports = { request };
