'use strict';

const fs   = require('fs');
const path = require('path');

// ─── Project awareness ───────────────────────────────────────────────────────
// Scans a project directory and returns a compact summary suitable for LLM
// context injection.  Detects project type, reads key config files, and
// generates a tree view of the directory structure.
//
// Two levels of detail:
//   scan()  — full tree + config file excerpts (tool call, detailed)
//   brief() — one-paragraph summary for system prompt injection (lightweight)

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '__pycache__',
  '.venv', 'venv', '.tox', 'target', '.gradle', '.idea', '.vscode',
  'coverage', '.nyc_output', '.cache', '.parcel-cache', 'out',
  '.turbo', '.svelte-kit', '.nuxt', 'vendor', '.angular',
]);

const CONFIG_DETECT = {
  'package.json':     'Node.js',
  'Cargo.toml':       'Rust',
  'pyproject.toml':   'Python',
  'setup.py':         'Python',
  'requirements.txt': 'Python',
  'go.mod':           'Go',
  'pom.xml':          'Java',
  'build.gradle':     'Java',
  'Gemfile':          'Ruby',
  'composer.json':    'PHP',
  'CMakeLists.txt':   'C/C++',
  'Makefile':         'Make',
  'tsconfig.json':    'TypeScript',
  'deno.json':        'Deno',
};

const KEY_FILES = [
  'package.json', 'tsconfig.json', 'Cargo.toml', 'pyproject.toml',
  'go.mod', '.env.example', 'CLAUDE.md', 'README.md',
];

// ── Directory walker ──────────────────────────────────────────────────────────

function walkDir(dir, maxDepth = 3, maxEntries = 300) {
  const entries = [];
  let count = 0;

  function walk(current, depth) {
    if (depth > maxDepth || count >= maxEntries) return;
    let items;
    try { items = fs.readdirSync(current, { withFileTypes: true }); }
    catch { return; }

    items.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

    for (const item of items) {
      if (count >= maxEntries) {
        entries.push({ name: '\u2026 (truncated)', depth });
        return;
      }
      if (item.name.startsWith('.') && item.isDirectory()) continue;
      if (SKIP_DIRS.has(item.name) && item.isDirectory()) continue;

      if (item.isDirectory()) {
        entries.push({ name: item.name + '/', depth, dir: true });
        walk(path.join(current, item.name), depth + 1);
      } else {
        entries.push({ name: item.name, depth, dir: false });
        count++;
      }
    }
  }

  walk(dir, 0);
  return entries;
}

function formatTree(entries) {
  return entries.map(e => '  '.repeat(e.depth) + e.name).join('\n');
}

// ── Detectors ─────────────────────────────────────────────────────────────────

function detectTypes(dir) {
  const types = new Set();
  for (const [file, type] of Object.entries(CONFIG_DETECT)) {
    if (fs.existsSync(path.join(dir, file))) types.add(type);
  }
  // Refine: TypeScript subsumes Node.js
  if (types.has('TypeScript') && types.has('Node.js')) types.delete('Node.js');
  return [...types];
}

function readPkg(dir) {
  const p = path.join(dir, 'package.json');
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return null; }
}

// ── Read key config files ─────────────────────────────────────────────────────

function readKeyFiles(dir, maxChars = 2000) {
  const out = {};
  for (const file of KEY_FILES) {
    const fp = path.join(dir, file);
    if (!fs.existsSync(fp)) continue;
    try {
      let text = fs.readFileSync(fp, 'utf8');
      if (file === 'package.json') {
        const pkg = JSON.parse(text);
        const slim = {};
        if (pkg.name)            slim.name            = pkg.name;
        if (pkg.version)         slim.version         = pkg.version;
        if (pkg.description)     slim.description     = pkg.description;
        if (pkg.main)            slim.main            = pkg.main;
        if (pkg.scripts)         slim.scripts         = pkg.scripts;
        if (pkg.dependencies)    slim.dependencies    = Object.keys(pkg.dependencies);
        if (pkg.devDependencies) slim.devDependencies = Object.keys(pkg.devDependencies);
        text = JSON.stringify(slim, null, 2);
      }
      if (text.length > maxChars) text = text.slice(0, maxChars) + '\n\u2026 (truncated)';
      out[file] = text;
    } catch { /* skip */ }
  }
  return out;
}

// ── Skill handlers ────────────────────────────────────────────────────────────

// Full scan — called as a tool by entities for detailed project context
async function scan({ path: projectPath, maxDepth = 3, maxFiles = 300 } = {}) {
  if (!projectPath) throw new Error('path is required.');
  if (!fs.existsSync(projectPath)) throw new Error(`Directory not found: ${projectPath}`);
  if (!fs.statSync(projectPath).isDirectory()) throw new Error(`Not a directory: ${projectPath}`);

  const types    = detectTypes(projectPath);
  const entries  = walkDir(projectPath, Math.min(maxDepth, 5), Math.min(maxFiles, 500));
  const tree     = formatTree(entries);
  const keyFiles = readKeyFiles(projectPath);

  const dirCount  = entries.filter(e => e.dir).length;
  const fileCount = entries.filter(e => !e.dir).length;

  const lines = [];
  lines.push(`Project: ${path.basename(projectPath)}`);
  lines.push(`Root: ${projectPath}`);
  if (types.length) lines.push(`Type: ${types.join(', ')}`);
  lines.push(`Structure: ${dirCount} directories, ${fileCount} files`);
  lines.push('');
  lines.push(tree);

  for (const [file, content] of Object.entries(keyFiles)) {
    lines.push('', `\u2500\u2500 ${file} \u2500\u2500`, content);
  }

  return lines.join('\n');
}

// Brief summary — called by renderer for system prompt injection (~100 tokens)
async function brief({ path: projectPath } = {}) {
  if (!projectPath || !fs.existsSync(projectPath)) return null;
  if (!fs.statSync(projectPath).isDirectory()) return null;

  const types = detectTypes(projectPath);
  const pkg   = readPkg(projectPath);

  const entries   = walkDir(projectPath, 2, 200);
  const dirCount  = entries.filter(e => e.dir).length;
  const fileCount = entries.filter(e => !e.dir).length;

  const keyPresent = KEY_FILES.filter(f => fs.existsSync(path.join(projectPath, f)));

  const lines = ['[PROJECT]'];
  lines.push(`Root: ${projectPath}`);
  if (types.length) lines.push(`Type: ${types.join(', ')}`);
  if (pkg?.name)    lines.push(`Name: ${pkg.name}${pkg.version ? ' v' + pkg.version : ''}`);
  if (pkg?.main)    lines.push(`Entry: ${pkg.main}`);
  lines.push(`Layout: ${dirCount} dirs, ${fileCount} files`);
  if (keyPresent.length) lines.push(`Config: ${keyPresent.join(', ')}`);
  if (pkg?.dependencies) {
    const deps = Object.keys(pkg.dependencies).slice(0, 15);
    lines.push(`Deps: ${deps.join(', ')}${Object.keys(pkg.dependencies).length > 15 ? ' ...' : ''}`);
  }

  return lines.join('\n');
}

module.exports = { scan, brief };
