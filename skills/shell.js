'use strict';

const { exec }    = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

// ─── Destructive command patterns ─────────────────────────────────────────────
// Any command matching one of these patterns triggers a confirmation prompt
// before execution.  Err on the side of caution — false positives just mean
// one extra click; false negatives can be unrecoverable.

const DESTRUCTIVE_PATTERNS = [
  /\brm\s/i,                          // rm (any form)
  /\bdel\b/i,                         // Windows del
  /\brmdir\b/i,                       // rmdir
  /\brd\s+\/s\b/i,                    // Windows rd /s
  /\bformat\b/i,                      // disk format
  /\bmkfs\b/i,                        // Linux mkfs
  /\bdd\b.*\bof=/i,                   // dd with output file
  /\bfdisk\b/i,                       // fdisk
  /\bgit\s+reset\s+--hard\b/i,       // git reset --hard
  /\bgit\s+clean\b/i,                 // git clean
  /\bgit\s+push\s+(--force|-f)\b/i,  // force push
  /\bnpm\s+run\s+.*clean\b/i,        // clean scripts
  /\bpowershell.*Remove-Item\b/i,    // PS Remove-Item
  /\bpowershell.*Format-Volume\b/i,  // PS Format-Volume
  />\s*(\/dev\/|[A-Z]:\\)/,           // redirect to device / root drive
];

function isDestructive(command) {
  return DESTRUCTIVE_PATTERNS.some(rx => rx.test(command));
}

// ─── shell.run ────────────────────────────────────────────────────────────────
// Execute a shell command and return { stdout, stderr, code }.
//
// Options:
//   command  — the shell command to run (required)
//   cwd      — working directory (default: process.cwd())
//   timeout  — ms before the process is killed (default: 30000)
//
// Destructive commands prompt the user for confirmation before running.
// If cancelled, returns { stdout:'', stderr:'', code: null, cancelled: true }.

async function run({ command, cwd, timeout = 30_000 }, ctx) {
  if (!command) throw new Error('command is required');

  if (isDestructive(command)) {
    const approved = await ctx.requestConfirm(
      `Shell command flagged as potentially destructive:\n\n${command}\n\nProceed?`
    );
    if (!approved) {
      return { stdout: '', stderr: '', code: null, cancelled: true };
    }
  }

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: cwd || process.cwd(),
      timeout,
      maxBuffer: 1024 * 1024, // 1 MB output cap
    });
    return { stdout: stdout.trim(), stderr: stderr.trim(), code: 0 };
  } catch (err) {
    // exec rejects on non-zero exit codes too — still return output
    return {
      stdout: err.stdout?.trim() ?? '',
      stderr: err.stderr?.trim() ?? err.message,
      code:   err.code ?? 1,
    };
  }
}

module.exports = { run, isDestructive };
