# Obsidian Web

Local web app (no dependencies) to browse and edit an Obsidian vault directly in the browser.

## Requirements

- Node.js 18+ (recommended)

## Run

Option A — server mode (the server reads/writes on disk): set your Obsidian vault path (the folder that contains your notes):

```bash
export OBSIDIAN_VAULT="/path/to/your/vault"
npm start
```

Or:

```bash
node server.js --vault "/path/to/your/vault" --port 5173
```

Then open `http://127.0.0.1:5173`.

## Notes

- `GET /api/list`, `GET /api/read`, `PUT /api/write` are restricted to the vault (protection against `..`).
- `.obsidian`, `.git`, `node_modules` are ignored in the file explorer.
- Option B — browser mode: start the server without a vault, then click **Choose local vault** (Chrome/Edge/Brave) to work directly on a folder selected from the browser.
- The editor auto-saves after ~1s of inactivity (you can still use Ctrl+S).
- Drag & drop: move a file by dragging it onto a folder in the left sidebar (move/rename).
- In preview mode, Obsidian links `[[...]]` are clickable and open the corresponding note.
