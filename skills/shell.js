'use strict';

const { exec }    = require('child_process');
const { promisify } = require('util');
const path          = require('path');
const fs            = require('fs');

const execAsync = promisify(exec);

// ─── Windows shell detection ──────────────────────────────────────────────────
// Prefer Git Bash (sh.exe) for Unix-command compatibility.
// Falls back to PowerShell, then cmd.exe.
// Detection runs once at startup and is cached.

const IS_WINDOWS = process.platform === 'win32';

function findGitBash() {
  if (!IS_WINDOWS) return null;
  const candidates = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    process.env.ProgramFiles  && path.join(process.env.ProgramFiles,  'Git', 'bin', 'bash.exe'),
    process.env.ProgramW6432  && path.join(process.env.ProgramW6432,  'Git', 'bin', 'bash.exe'),
  ].filter(Boolean);
  return candidates.find(p => { try { return fs.existsSync(p); } catch { return false; } }) ?? null;
}

const GIT_BASH = findGitBash();

// Build exec options appropriate for the current platform.
// On Windows with Git Bash available: run via bash -c so Unix commands work.
// On Windows without Git Bash: use PowerShell (better than cmd for most tasks).
// On Unix/Mac: use the default shell.
function shellOpts(cwd, timeout) {
  const base = { cwd: cwd || process.cwd(), timeout, maxBuffer: 1024 * 1024 };
  if (!IS_WINDOWS) return base;  // Node picks /bin/sh automatically
  if (GIT_BASH)   return { ...base, shell: GIT_BASH };
  // PowerShell fallback — wraps the command so it behaves more like sh
  return { ...base, shell: 'powershell.exe' };
}

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
    const { stdout, stderr } = await execAsync(command, shellOpts(cwd, timeout));
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
