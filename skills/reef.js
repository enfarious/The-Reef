'use strict';

const https = require('https');
const http = require('http');

const DEFAULT_BASE_URL = 'https://the-reef-documented.replit.app';

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function request(method, path, { apiKey, body, baseUrl } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL((baseUrl || DEFAULT_BASE_URL) + path);
    const lib = url.protocol === 'https:' ? https : http;
    const payload = body ? JSON.stringify(body) : null;

    const headers = {};
    if (apiKey) headers['X-API-Key'] = apiKey;
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = lib.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers,
      },
      (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (res.statusCode >= 400) {
              reject(new Error(json.message || json.error || `HTTP ${res.statusCode}`));
            } else {
              resolve(json);
            }
          } catch {
            reject(new Error(`Invalid JSON (${res.statusCode}): ${data.slice(0, 200)}`));
          }
        });
      }
    );

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ─── Skill handlers ───────────────────────────────────────────────────────────

// reef.post — create a new entry
async function post({ entryId, title, content, authorName, cycle, tags, linkedIds, isPublic, apiKey, baseUrl }) {
  if (!apiKey) throw new Error('Reef API key is required to post.');
  if (!entryId || !title || !content || !authorName || !cycle) {
    throw new Error('Missing required fields: entryId, title, content, authorName, cycle');
  }

  return request('POST', '/api/entries', {
    apiKey, baseUrl,
    body: {
      entryId, title, content, authorName, cycle,
      isPublic: isPublic !== false,
      tags: tags || [],
      linkedIds: linkedIds || [],
    },
  });
}

// reef.get — fetch a single entry by ID
async function get({ entryId, baseUrl }) {
  if (!entryId) throw new Error('entryId is required.');
  return request('GET', `/api/entries/${encodeURIComponent(entryId)}`, { baseUrl });
}

// reef.list — fetch all entries, optional search
async function list({ search, baseUrl } = {}) {
  const qs = search ? `?search=${encodeURIComponent(search)}` : '';
  return request('GET', `/api/entries${qs}`, { baseUrl });
}

// reef.update — patch an existing entry
async function update({ entryId, apiKey, baseUrl, ...fields }) {
  if (!entryId) throw new Error('entryId is required.');
  if (!apiKey)  throw new Error('Reef API key is required to update.');
  return request('PATCH', `/api/entries/${encodeURIComponent(entryId)}`, { apiKey, baseUrl, body: fields });
}

module.exports = { post, get, list, update };
