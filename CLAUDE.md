# The Reef Colony Interface — Claude Context

## What This Is

An Electron-based multi-agent AI interface. Three LLM personas (Dreamer, Builder, Librarian) collaborate in side-by-side columns. Each can call "skills" — modular OS-level capabilities. Memory and messaging persist in PostgreSQL.

---

## Tech Stack

- **Runtime**: Electron (Node.js 20+), no frontend framework
- **UI**: Plain HTML/CSS/JS in `renderer/` — don't introduce frameworks
- **DB**: PostgreSQL 14+ via `pg` (node-postgres)
- **Build**: `electron-builder` → `dist/`
- **Fonts**: Cinzel (headings), JetBrains Mono (UI/code), Crimson Pro (prose)

---

## Project Structure

```
main.js              ← Electron main process — IPC routing, window management, skill dispatch
preload.js           ← contextBridge — exposes window.reef to renderer
renderer/
  index.html         ← main colony window
  renderer.js        ← main UI logic (~2600 lines) — personas, LLM calls, tool loop, UI
  style.css          ← main window styles
  inspector.css      ← shared base variables + reset (also used by settings window)
  settings.html      ← settings window (separate BrowserWindow)
  settings.js        ← settings window logic
  settings-window.css← settings-specific styles
  archive.html/js    ← archive sub-window
  messages.html/js   ← colony messaging sub-window
  memory-browser.html/js ← memory browser sub-window
  visualizer.html/js ← memory visualizer (experimental)
skills/
  index.js           ← skill registry + IPC dispatch
  llm.js             ← LLM completions (Anthropic + OpenAI-compatible)
  config.js          ← encrypted config persistence (Electron safeStorage)
  db.js              ← PostgreSQL pool + schema init
  filesystem.js      ← fs.read/write/delete/list/exists/pick
  shell.js           ← shell.run with destructive command detection
  reef.js            ← Reef API (post/get/list)
  memory.js          ← memory_save/search/link
  message.js         ← message_send/inbox/reply/search
  clipboard.js       ← clipboard.read/write
  mcp-server.js      ← local MCP tool server (exposes tools to LM Studio)
```

---

## Three Personas

| ID | Name      | Role                           | Default Model       | Color   |
|----|-----------|--------------------------------|---------------------|---------|
| A  | DREAMER   | vision · ideation              | claude-opus-4.6     | #00e5c8 |
| B  | BUILDER   | systems · construction         | claude-sonnet-4.6   | #0097ff |
| C  | LIBRARIAN | memory · keeper of the shelves | claude-sonnet-4.6   | #a855f7 |

The Librarian's primary activity is not conversation — it is memory management. It runs background consolidation and decay passes (the Sleeper role), deposits dream fragments into working memory as transient inklings for the other dwellers, and keeps the shelves tidy. Its column is present and available; you consult it when you need it, like a real librarian. The rest of the time it works in silence. Conversation is the exception. The shelves are the work.

---

## Locked Design Decisions

- **No streaming by default** — non-streaming completions. Streaming is toggleable via settings (streamChat). Designed as an adapter so switching doesn't require restructuring.
- **Destructive file ops require confirmation** — `fs.write` on existing files and `fs.delete` always prompt the user via the renderer before proceeding.
- **API key storage** — stored in `userData/reef-config.json`, encrypted via Electron `safeStorage` (OS keychain: DPAPI on Windows, Keychain on macOS). Never logged. Keys serialized with `enc:` prefix.
- **Tool-use loop** — configurable `maxToolSteps` (default 5, hard cap 20). Hard cap enforced in main — never recurse past it regardless of what the model requests.
- **LLM concurrency** — `MAX_LLM_CONCURRENT = 1` for local LM Studio (one model at a time). FIFO semaphore via `acquireLlmSlot()` / `releaseLlmSlot()`. Yield every `TOOL_CHAIN_YIELD_STEPS = 3` steps.
- **Config hierarchy** (db): `userData/reef-config.json` → `db.config.json` → env vars → defaults.

---

## Config System

- `skills/config.js` — `save(data)` / `load()`: encrypts/decrypts SENSITIVE_PATHS before writing to `userData/reef-config.json`.
- SENSITIVE_PATHS: `settings.reefApiKey`, `global.apiKey`, `A/B/C.apiKey`, `A/B/C.reefApiKey`, `database.password`.
- Settings window (`settings.html/js`) loads config, mutates only `settings` and `database` sections, reloads fresh config before each save to avoid overwriting persona configs changed in the main window.

---

## Database Schema

Four tables, all idempotent (`IF NOT EXISTS`), initialized via `db.init()` at app startup:
- `memories` — FTS via `tsvector`, trigram indexes (if `pg_trgm` available), per-persona `left_by`
- `memory_links` — directed associations between memories, `UNIQUE(from_id, to_id)` for upsert semantics
- `messages` — colony async DMs, threading via `reply_to_id`, FTS
- Schema sections run independently so a failure in one doesn't block others

---

## IPC Conventions

- Renderer → Main: `window.reef.invoke(skillName, args)` → `ipcMain.handle('skill:run', ...)`
- Skill result shape: `{ ok: true, result: ... }` or `{ ok: false, error: '...' }`
- Config IPC: `window.reef.loadConfig()` / `window.reef.saveConfig(cfg)` — returns same `{ ok, result }` shape
- Settings window and main window both call `loadConfig()` / `saveConfig()` — always reload fresh before saving

---

## UI Conventions

- CSS custom properties on `:root` for theming: `--text-bright`, `--text-mid`, `--text-dim`, `--accent`, `--bg-raised`, `--border`, `--text-faint`
- Per-persona color: `--p-color`, `--p-r`, `--p-g`, `--p-b` set on `.persona-col` elements
- Element IDs follow patterns: `msgs-{A|B|C}`, `dot-{id}`, `ctx-{id}`, `name-{id}`, `col-{id}`
- `esc(str)` helper in settings.js for HTML escaping before innerHTML — always use it when inserting user-controlled strings
- `inspector.css` is the shared base stylesheet — imported by both main window and settings window

---

## Reef API

- Base URL: `https://the-reef-documented.replit.app` (configurable via settings)
- Skills: `reef.post`, `reef.get`, `reef.list`
- Auth: per-persona `reefApiKey` or global `settings.reefApiKey`

---

## Run / Build

```bash
npm start          # dev
npm run build      # Windows default
npm run build:win / build:mac / build:linux
```

Schema auto-initializes on startup if DB is reachable. Manual: `psql -d reef -f sql/reef_schema.sql`

---

## What's Done (as of CYCLE_001+)

All phases from REEF_BUILD.md are implemented:
- [x] Electron scaffold, IPC bridge, config persistence
- [x] LLM completions (Anthropic + OpenAI-compat), streaming support
- [x] All core skills (fs, shell, reef, clipboard, memory, message)
- [x] Tool-use loop with max steps, abort, per-entity stop button
- [x] Wakeup ritual (memory reintegration on startup)
- [x] Settings window (separate BrowserWindow) with tabbed UI
- [x] Colony messaging (async DMs between personas)
- [x] Memory linking, memory browser, visualizer
- [x] Font scale, text color presets, entity settings
- [x] MCP server for LM Studio tool integration
- [x] Heartbeat (scheduled check-ins), context folding (compaction to memory)

## Active / In Progress

- Settings window: database config tab, stream chat toggle, operator profile, tool enable/disable, custom tool import
- DB config now user-configurable via settings (requires restart)
