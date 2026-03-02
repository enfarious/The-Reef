'use strict';

const https = require('https');

// ─── Reddit read-only API ────────────────────────────────────────────────────
// Uses old.reddit.com JSON endpoints — no auth required.
// Respects Reddit's API guidelines: proper User-Agent, no aggressive polling.

const USER_AGENT = 'TheReefColony/1.0 (Electron; multi-agent AI interface)';
const TIMEOUT    = 15_000;

// ── HTTP helper ──────────────────────────────────────────────────────────────

function get(urlStr) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const req = https.request(
      {
        hostname: url.hostname,
        path:     url.pathname + url.search,
        method:   'GET',
        headers:  { 'User-Agent': USER_AGENT },
        timeout:  TIMEOUT,
      },
      (res) => {
        // Follow one redirect (Reddit sometimes 301s to www)
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return get(res.headers.location).then(resolve, reject);
        }
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          if (res.statusCode === 429) {
            return reject(new Error('Reddit rate limit hit. Wait a minute and try again.'));
          }
          if (res.statusCode >= 400) {
            return reject(new Error(`Reddit returned HTTP ${res.statusCode}`));
          }
          try { resolve(JSON.parse(body)); }
          catch { reject(new Error(`Invalid JSON from Reddit: ${body.slice(0, 200)}`)); }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Reddit request timed out.')); });
    req.end();
  });
}

// ── Formatting helpers ───────────────────────────────────────────────────────

function decodeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x200B;/g, '');
}

function relativeTime(utcSeconds) {
  const diff = Date.now() / 1000 - utcSeconds;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 2592000) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(utcSeconds * 1000).toISOString().slice(0, 10);
}

function formatPost(post, includeBody = false) {
  const d = post.data;
  const lines = [
    `[${d.score}↑] ${decodeHtml(d.title)}`,
    `  r/${d.subreddit} · u/${d.author} · ${relativeTime(d.created_utc)} · ${d.num_comments} comments`,
    `  https://reddit.com${d.permalink}`,
  ];
  if (includeBody && d.selftext) {
    const body = decodeHtml(d.selftext).slice(0, 1500);
    lines.push('', '  ' + body.split('\n').join('\n  '));
  }
  return lines.join('\n');
}

function formatComment(comment, depth = 0) {
  const d = comment.data;
  if (!d || !d.body || d.author === 'AutoModerator') return '';
  const indent = '  '.repeat(depth);
  const body = decodeHtml(d.body).slice(0, 800);
  const lines = [
    `${indent}[${d.score}↑] u/${d.author} · ${relativeTime(d.created_utc)}`,
    ...body.split('\n').map(l => `${indent}  ${l}`),
  ];
  return lines.join('\n');
}

// ── Skill handlers ───────────────────────────────────────────────────────────

// reddit.search — search all of Reddit (or a specific subreddit)
async function search({ query, subreddit, sort = 'relevance', limit = 10 }) {
  if (!query) throw new Error('query is required.');
  const n = Math.min(Math.max(1, Number(limit) || 10), 25);
  const sub = subreddit ? `r/${subreddit.replace(/^r\//, '')}/` : '';
  const url = `https://old.reddit.com/${sub}search.json?q=${encodeURIComponent(query)}&sort=${sort}&limit=${n}&restrict_sr=${subreddit ? 'on' : 'off'}&t=all`;

  const json = await get(url);
  const posts = (json?.data?.children || []);
  if (!posts.length) return 'No results found.';

  return posts.map(p => formatPost(p)).join('\n\n');
}

// reddit.hot — browse a subreddit's hot/new/top posts
async function hot({ subreddit, sort = 'hot', limit = 10, time = 'week' }) {
  if (!subreddit) throw new Error('subreddit is required (e.g. "javascript", "node").');
  const sub = subreddit.replace(/^r\//, '');
  const n = Math.min(Math.max(1, Number(limit) || 10), 25);
  const timeParam = sort === 'top' ? `&t=${time}` : '';
  const url = `https://old.reddit.com/r/${encodeURIComponent(sub)}/${sort}.json?limit=${n}${timeParam}`;

  const json = await get(url);
  const posts = (json?.data?.children || []);
  if (!posts.length) return `r/${sub} returned no posts (may not exist or is empty).`;

  return posts.map(p => formatPost(p)).join('\n\n');
}

// reddit.post — read a specific post + top comments
async function post({ url: postUrl, postId, limit = 15 }) {
  if (!postUrl && !postId) throw new Error('Provide either url or postId.');
  const n = Math.min(Math.max(1, Number(limit) || 15), 30);

  let jsonUrl;
  if (postUrl) {
    // Normalise: strip trailing slash, swap to old.reddit.com, append .json
    const clean = postUrl
      .replace(/https?:\/\/(www\.|new\.)?reddit\.com/, 'https://old.reddit.com')
      .replace(/\?.*$/, '')
      .replace(/\/$/, '');
    jsonUrl = `${clean}.json?limit=${n}&sort=top`;
  } else {
    jsonUrl = `https://old.reddit.com/comments/${postId}.json?limit=${n}&sort=top`;
  }

  const json = await get(jsonUrl);
  // Reddit returns [postListing, commentListing]
  const postData = json?.[0]?.data?.children?.[0];
  const comments = json?.[1]?.data?.children || [];

  if (!postData) return 'Post not found.';

  const lines = [formatPost(postData, true)];

  if (comments.length) {
    lines.push('', '─── TOP COMMENTS ───', '');
    let commentCount = 0;
    for (const c of comments) {
      if (commentCount >= n) break;
      const formatted = formatComment(c, 0);
      if (!formatted) continue;
      lines.push(formatted, '');
      commentCount++;

      // Include one level of replies for top comments
      const replies = c.data?.replies?.data?.children || [];
      for (const r of replies.slice(0, 3)) {
        if (r.kind !== 't1') continue;
        const reply = formatComment(r, 1);
        if (reply) { lines.push(reply, ''); commentCount++; }
      }
    }
  }

  return lines.join('\n').trim();
}

module.exports = { search, hot, post };
