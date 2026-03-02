'use strict';

const { execFile } = require('child_process');

// ─── Code search via ripgrep ────────────────────────────────────────────────────
// Provides fast, structured code search using rg.  Output is kept compact and
// token-efficient for LLM consumption.

const MAX_BUFFER = 512 * 1024;   // 512 KB stdout cap
const TIMEOUT    = 30_000;       // 30 s

async function search({
  pattern,
  cwd,
  glob,
  context     = 0,
  maxResults  = 50,
  caseSensitive = true,
  fixedStrings  = false,
}) {
  if (!pattern) throw new Error('pattern is required.');

  const dir = cwd || process.cwd();

  // ── Build ripgrep args ──────────────────────────────────────────────────────
  const args = [
    '--line-number',
    '--no-heading',
    '--color', 'never',
  ];

  if (!caseSensitive) args.push('--ignore-case');
  if (fixedStrings)   args.push('--fixed-strings');
  if (context > 0)    args.push('--context', String(Math.min(context, 10)));
  if (glob)           args.push('--glob', glob);

  // '--' separates flags from the pattern to avoid flag-injection
  args.push('--', pattern, '.');

  return new Promise((resolve, reject) => {
    execFile('rg', args, {
      cwd:         dir,
      maxBuffer:   MAX_BUFFER,
      timeout:     TIMEOUT,
      windowsHide: true,
    }, (err, stdout, stderr) => {
      if (err?.code === 'ENOENT') {
        return reject(new Error(
          'ripgrep (rg) is not installed. Install it:\n' +
          'https://github.com/BurntSushi/ripgrep#installation'
        ));
      }
      if (err?.killed) {
        return reject(new Error('Search timed out (30 s). Try a narrower pattern or glob.'));
      }
      // rg exits 1 when there are no matches — not an error
      if (err && err.code !== 1) {
        return reject(new Error(stderr?.trim() || err.message));
      }

      const raw = (stdout || '').trim();
      if (!raw) return resolve('No matches found.');

      // ── Cap to maxResults match lines ───────────────────────────────────────
      const lines = raw.split('\n');
      let matchCount = 0;
      const kept = [];

      for (const line of lines) {
        // rg separates context groups with '--'
        if (line === '--') { kept.push(line); continue; }
        // Match lines: file:line:content   Context lines: file-line-content
        if (/^\S+?:\d+:/.test(line)) matchCount++;
        if (matchCount > maxResults) {
          kept.push(`\n… truncated (${maxResults} of ${matchCount + lines.length - kept.length} matches shown)`);
          break;
        }
        kept.push(line);
      }

      resolve(kept.join('\n'));
    });
  });
}

module.exports = { search };
