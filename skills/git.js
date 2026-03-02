'use strict';

const { execFile } = require('child_process');

// ─── Git operations ─────────────────────────────────────────────────────────────
// Curated set of git commands exposed as structured skills.  Uses execFile (no
// shell) so arguments are never interpreted — safe from injection.

const MAX_BUFFER = 512 * 1024;
const TIMEOUT    = 30_000;

function git(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd:         cwd || process.cwd(),
      maxBuffer:   MAX_BUFFER,
      timeout:     TIMEOUT,
      windowsHide: true,
    }, (err, stdout, stderr) => {
      if (err?.code === 'ENOENT') {
        return reject(new Error('git is not installed or not in PATH.'));
      }
      if (err) {
        // Many git commands write useful info to stderr even on success.
        // Only reject if the exit code is truly non-zero.
        return reject(new Error(stderr?.trim() || stdout?.trim() || err.message));
      }
      resolve(stdout.trim());
    });
  });
}

// ─── Status ──────────────────────────────────────────────────────────────────

async function status({ cwd } = {}) {
  return (await git(['status', '--short', '--branch'], cwd)) || 'Working tree clean.';
}

// ─── Diff ────────────────────────────────────────────────────────────────────

async function diff({ cwd, staged = false, file, stat = false } = {}) {
  const args = ['diff'];
  if (staged)  args.push('--staged');
  if (stat)    args.push('--stat');
  if (file)    args.push('--', file);
  return (await git(args, cwd)) || 'No differences.';
}

// ─── Log ─────────────────────────────────────────────────────────────────────

async function log({ cwd, count = 20, file } = {}) {
  const n = Math.min(Math.max(1, Number(count) || 20), 100);
  const args = ['log', '--pretty=format:%h %ad %s', '--date=short', `-n`, String(n)];
  if (file) args.push('--', file);
  return (await git(args, cwd)) || 'No commits yet.';
}

// ─── Commit ──────────────────────────────────────────────────────────────────

async function commit({ cwd, message, files } = {}) {
  if (!message) throw new Error('Commit message is required.');
  // Stage specific files if provided (-- prevents flag injection via filenames)
  if (Array.isArray(files) && files.length) {
    await git(['add', '--', ...files], cwd);
  }
  return await git(['commit', '-m', message], cwd);
}

// ─── Branch ──────────────────────────────────────────────────────────────────

async function branch({ cwd, action = 'list', name } = {}) {
  switch (action) {
    case 'list':
      return (await git(['branch', '-a', '--no-color'], cwd)) || 'No branches.';
    case 'create':
      if (!name) throw new Error('Branch name is required.');
      return await git(['checkout', '-b', name], cwd);
    case 'switch':
      if (!name) throw new Error('Branch name is required.');
      return await git(['checkout', name], cwd);
    case 'delete':
      if (!name) throw new Error('Branch name is required.');
      return await git(['branch', '-d', name], cwd);
    default:
      throw new Error(`Unknown branch action: "${action}". Use list, create, switch, or delete.`);
  }
}

// ─── Push ────────────────────────────────────────────────────────────────────

async function push({ cwd, remote = 'origin', branch: branchName } = {}) {
  const args = ['push', remote];
  if (branchName) args.push(branchName);
  return (await git(args, cwd)) || 'Push complete (up to date).';
}

module.exports = { status, diff, log, commit, branch, push };
