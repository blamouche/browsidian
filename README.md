# Obsidian Web

Obsidian Web is a local web app to browse and edit an Obsidian vault directly in your browser.

It supports two working modes:

- **Server mode**: a local Node.js server reads/writes files on disk in a configured vault folder.
- **Browser mode**: the browser accesses a folder you pick (File System Access API) and edits it directly (no vault configured on the server).

## Features

- Browse vault folders and files (tree view)
- Search files by path/name (client-side filter)
- Create folders and files
- Edit Markdown with **auto-save** (~1s inactivity) and **Ctrl+S**
- **Preview mode** (basic Markdown → HTML) when not focused; click to edit Markdown
- Obsidian **wikilinks** in preview: `[[Note]]`, `[[Note|Alias]]` (click to navigate)
- Basic Markdown tables in preview
- Drag & drop a file onto a folder to move it
- Dark / Light mode toggle (persisted in `localStorage`)
- Footer shows app version from `/api/config`

## Requirements

- Node.js 18+ (recommended)
- For **Browser mode**: Chrome / Edge / Brave (File System Access API)

## Getting started

### Browser mode (no server vault)

Start the server without `OBSIDIAN_VAULT`/`--vault`:

```bash
npm start
```

Open the app, then click **Choose local vault** and select your vault folder.

## UI behavior

- **Preview vs Edit**
  - When a file is opened, the app shows an HTML preview.
  - Click the preview to switch to Markdown editing.
  - When the editor loses focus, it switches back to preview.
- **Saving**
  - Auto-save runs after ~1.2s without typing (when a file is dirty).
  - You can always press **Ctrl+S** (or click **Save**) to save immediately.
- **Moving files**
  - Drag a file from the tree and drop it on a folder to move it there (a confirmation dialog is shown).

## Markdown preview support (basic)

The preview is intentionally simple (no external dependencies). It supports:

- Headings (`#` to `####`)
- Paragraphs
- Bold/italic
- Inline code and fenced code blocks (```…```)
- Blockquotes
- Horizontal rules
- Links: `[label](https://example.com)`
- Tables (header + separator row)
- Obsidian wikilinks: `[[Note]]`, `[[Note|Alias]]`

Notes:

- Section anchors in wikilinks (e.g. `[[Note#Heading]]`) are ignored for now (the file opens, but it does not scroll).
- Table alignment markers are ignored (rendered as a normal table).

## Security model

- In **Server mode**, file operations are restricted to the configured vault root (prevents `..` path traversal).
- In both modes, some directories are hidden from the tree: `.obsidian`, `.git`, `node_modules`, `.trash`, `.DS_Store`.
- This app is meant to run locally on your laptop. Do not expose it publicly.

## Troubleshooting

- **I still see old UI text / behavior**
  - Hard refresh the page (disable cache).
  - Ensure you restarted the running `node server.js` process.
- **Choose local vault button is disabled**
  - Use Chrome/Edge/Brave and serve the app from `http://127.0.0.1` (recommended).
- **I can’t edit files in Browser mode**
  - The browser will ask for permission to read/write the selected folder. Accept it.

## License

Not specified.
