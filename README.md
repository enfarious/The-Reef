# The Reef

Electron-based multi-agent interface for persistent AI collaboration, memory, and tool use.

## Required Tech Stack

- Node.js 20+ (LTS recommended)
- npm 10+
- Electron 40 (`electron`)
- Electron Builder 26 (`electron-builder`)
- PostgreSQL 14+ (required for memory/message persistence)
- `pg` Node driver

## What This App Uses

- Electron main process (`main.js`) for app lifecycle, IPC, and window management
- Secure preload bridge (`preload.js`) using `contextBridge`
- Renderer UI in `renderer/` (HTML/CSS/JS)
- Skill system in `skills/`:
  - LLM calls (`llm.*`)
  - Memory + messaging (`memory.*`, `message.*`)
  - File system and shell tools (`fs.*`, `shell.run`)
  - Reef API integration (`reef.*`)
- PostgreSQL-backed schema for memories, messages, and memory links

## Quick Setup

1. Install dependencies:

```bash
npm install
```

2. Configure PostgreSQL connection:

```bash
# macOS/Linux
cp db.config.example.json db.config.json

# PowerShell
Copy-Item db.config.example.json db.config.json
```

Then edit `db.config.json` with your local DB credentials.

3. Create schema (no data):

```bash
# macOS/Linux
psql -h localhost -U postgres -d reef -f sql/reef_schema.sql

# PowerShell
psql -h localhost -U postgres -d reef -f .\sql\reef_schema.sql
```

4. Start the app:

```bash
npm start
```

On launch, the app also attempts schema initialization automatically if the configured database is reachable.

## Build

- Build default target:

```bash
npm run build
```

- Platform-specific:

```bash
npm run build:win
npm run build:mac
npm run build:linux
```

Build output is written to `dist/`.

## Config Notes

- Runtime app config is saved by the app via `skills/config.js`.
- Database config is read from `db.config.json` (or DB env vars as fallback).
- Keep API keys out of source control.

## Project Structure

```text
.
|- main.js
|- preload.js
|- renderer/
|- skills/
|- assets/
|- db.config.example.json
|- package.json
```
