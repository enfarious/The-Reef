'use strict';

const https = require('https');

// ─── Tavily web search ─────────────────────────────────────────────────────────
// Docs: https://docs.tavily.com/documentation/rest-api/api-reference

async function search({ query, apiKey, maxResults = 5, searchDepth = 'basic', topic = 'general', includeAnswer = true }) {
  if (!query)  throw new Error('query is required.');
  if (!apiKey) throw new Error('Tavily API key is required. Add it in Settings → General.');

  const payload = JSON.stringify({
    api_key:        apiKey,
    query,
    search_depth:   searchDepth,
    topic,
    include_answer: includeAnswer,
    max_results:    Math.min(10, Math.max(1, Number(maxResults) || 5)),
  });

  const json = await new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.tavily.com',
        path:     '/search',
        method:   'POST',
        headers:  {
          'Content-Type':   'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            if (res.statusCode >= 400) {
              reject(new Error(parsed.error?.message || parsed.message || `HTTP ${res.statusCode}`));
            } else {
              resolve(parsed);
            }
          } catch {
            reject(new Error(`Invalid JSON (HTTP ${res.statusCode}): ${body.slice(0, 200)}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });

  // ── Format results for LLM consumption ──────────────────────────────────────
  const lines = [];

  if (json.answer) {
    lines.push(`SUMMARY: ${json.answer}`, '');
  }

  (json.results || []).forEach((r, i) => {
    lines.push(`[${i + 1}] ${r.title}`);
    lines.push(`    ${r.url}`);
    if (r.published_date) lines.push(`    Published: ${r.published_date}`);
    lines.push(`    ${r.content}`);
    lines.push('');
  });

  return lines.join('\n').trim() || 'No results found.';
}

module.exports = { search };
