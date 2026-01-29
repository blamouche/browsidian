const treeEl = document.getElementById("tree");
const searchEl = document.getElementById("search");
const editorEl = document.getElementById("editor");
const previewEl = document.getElementById("preview");
const saveBtn = document.getElementById("saveBtn");
const statusEl = document.getElementById("status");
const currentPathEl = document.getElementById("currentPath");
const dirtyEl = document.getElementById("dirty");
const vaultNameEl = document.getElementById("vaultName");
const newFileBtn = document.getElementById("newFileBtn");
const newFolderBtn = document.getElementById("newFolderBtn");
const selectVaultBtn = document.getElementById("selectVaultBtn");
const useServerBtn = document.getElementById("useServerBtn");
const createActionsEl = document.getElementById("createActions");
const appVersionEl = document.getElementById("appVersion");
const themeToggleEl = document.getElementById("themeToggle");
const contextMenuEl = document.getElementById("contextMenu");
const contextDeleteFileEl = document.getElementById("contextDeleteFile");

const promptDialog = document.getElementById("promptDialog");
const promptTitle = document.getElementById("promptTitle");
const promptLabel = document.getElementById("promptLabel");
const promptInput = document.getElementById("promptInput");
const promptHelp = document.getElementById("promptHelp");

const vaultDialog = document.getElementById("vaultDialog");
const vaultChooseBtn = document.getElementById("vaultChooseBtn");
const vaultDemoBtn = document.getElementById("vaultDemoBtn");
const vaultDropboxBtn = document.getElementById("vaultDropboxBtn");

const dropboxPathDialog = document.getElementById("dropboxPathDialog");
const dropboxPathBreadcrumb = document.getElementById("dropboxPathBreadcrumb");
const dropboxPathInput = document.getElementById("dropboxPathInput");
const dropboxPathHelp = document.getElementById("dropboxPathHelp");
const dropboxPathList = document.getElementById("dropboxPathList");
const dropboxPathUpBtn = document.getElementById("dropboxPathUpBtn");
const dropboxPathNewBtn = document.getElementById("dropboxPathNewBtn");
const dropboxPathSelectBtn = document.getElementById("dropboxPathSelectBtn");

const state = {
  mode: "server", // "server" | "browser" | "demo" | "dropbox"
  vaultLabel: "",
  appVersion: null,
  selectedDir: null,
  rootHandle: null,
  dropbox: null, // { accessToken, refreshToken, expiresAt, accountId, rootPath }
  expandedDirs: new Set([""]),
  childrenByDir: new Map(), // dir -> entries[]
  activeFile: null,
  activeFileContent: "",
  dirty: false,
  filter: "",
  autosaveTimer: null,
  autosaveInFlight: false,
  autosaveQueued: false,
  draggingPath: null,
  fileIndex: null,
  fileIndexPromise: null
};

const IGNORED_DIRS = new Set([".obsidian", ".git", "node_modules", ".trash", ".DS_Store"]);
const AUTOSAVE_DELAY_MS = 1200;

function setStatus(msg) {
  statusEl.textContent = msg;
}

const dropboxAuthStore = (() => {
  const KEY = "dropboxAuthV1";

  function get() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return null;
      return parsed;
    } catch {
      return null;
    }
  }

  function set(auth) {
    try {
      localStorage.setItem(KEY, JSON.stringify(auth));
    } catch {}
  }

  function clear() {
    try {
      localStorage.removeItem(KEY);
    } catch {}
  }

  return { get, set, clear };
})();

function normalizeDropboxRootPath(input) {
  const s = (input ?? "").toString().trim();
  if (!s || s === "/") return "";
  const cleaned = s.replaceAll("\\", "/").replaceAll(/\/+$/g, "");
  return cleaned.startsWith("/") ? cleaned : `/${cleaned}`;
}

function dropboxPathFor(relPath) {
  const rel = (relPath ?? "").toString().replaceAll("\\", "/").replaceAll(/^\/+/g, "");
  const root = state.dropbox?.rootPath || "";
  if (!root) return rel ? `/${rel}` : "";
  return rel ? `${root}/${rel}` : root;
}

async function apiPostJson(url, payload) {
  return await apiSend("POST", url, payload);
}

async function dropboxGetConfig() {
  const cfg = await apiGet("/api/dropbox/oauth/config").catch(() => null);
  const key = (cfg?.appKey || "").toString().trim();
  const redirectUri = (cfg?.redirectUri || "").toString().trim();
  return { appKey: key || null, redirectUri: redirectUri || null };
}

function base64Url(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 1) s += String.fromCharCode(bytes[i]);
  const b64 = btoa(s).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  return b64;
}

async function sha256Base64Url(input) {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return base64Url(new Uint8Array(hash));
}

function randomString(len = 64) {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

async function dropboxExchangeCode({ code, codeVerifier, redirectUri }) {
  const data = await apiPostJson("/api/dropbox/oauth/exchange", { code, codeVerifier, redirectUri });
  return data;
}

async function dropboxRefresh({ refreshToken }) {
  const data = await apiPostJson("/api/dropbox/oauth/refresh", { refreshToken });
  return data;
}

async function dropboxEnsureAccessToken() {
  if (!state.dropbox) throw new Error("Not connected to Dropbox");
  const now = Date.now();
  const expiresAt = Number(state.dropbox.expiresAt || 0);
  if (expiresAt && now < expiresAt - 30_000) return state.dropbox.accessToken;

  if (!state.dropbox.refreshToken) throw new Error("Dropbox session expired");
  const refreshed = await dropboxRefresh({ refreshToken: state.dropbox.refreshToken });
  const token = (refreshed?.accessToken || "").toString();
  const expiresIn = Number(refreshed?.expiresIn || 0);
  if (!token || !Number.isFinite(expiresIn)) throw new Error("Failed to refresh Dropbox token");
  state.dropbox.accessToken = token;
  state.dropbox.expiresAt = Date.now() + expiresIn * 1000;
  dropboxAuthStore.set(state.dropbox);
  return token;
}

async function dropboxApiJson(path, payload) {
  const token = await dropboxEnsureAccessToken();
  const res = await fetch(`/api/dropbox/files/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-dropbox-access-token": token },
    body: JSON.stringify(payload)
  });
  const raw = await res.text().catch(() => "");
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {}
  if (!res.ok) throw new Error(data?.error || data?.error_summary || raw || `Dropbox HTTP ${res.status}`);
  return data;
}

async function dropboxDownloadText(dropboxPath) {
  const token = await dropboxEnsureAccessToken();
  const res = await fetch("/api/dropbox/files/read", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-dropbox-access-token": token },
    body: JSON.stringify({ path: dropboxPath })
  });
  const raw = await res.text().catch(() => "");
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {}
  if (!res.ok) throw new Error(data?.error || data?.error_summary || raw || `Dropbox HTTP ${res.status}`);
  return (data?.content ?? "").toString();
}

async function dropboxUploadText(dropboxPath, content) {
  const token = await dropboxEnsureAccessToken();
  const res = await fetch("/api/dropbox/files/write", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-dropbox-access-token": token },
    body: JSON.stringify({ path: dropboxPath, content: (content ?? "").toString() })
  });
  const raw = await res.text().catch(() => "");
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {}
  if (!res.ok) throw new Error(data?.error || data?.error_summary || raw || `Dropbox HTTP ${res.status}`);
  return data;
}

const demoVaultStore = (() => {
  const KEY = "demoVaultV1";
  const SEP = "/";
  const WELCOME_PATH = "Welcome.md";
  const WELCOME_UPGRADE_MARKER = "# Browsidian — Demo Vault";

  function defaultWelcomeMd() {
    return `# Browsidian — Demo Vault

Welcome! This is a **safe, in-browser demo vault** that lets you try the UI without connecting a real folder.

## Why you might like this

- **Fast**: browse, search, create, and edit notes in seconds
- **Familiar**: Obsidian-style wikilinks like \`[[My note]]\`
- **Comfortable**: Markdown editor + preview + auto-save
- **Private**: in Demo mode, everything stays in your browser (stored in \`localStorage\`)

## Quick start (2 minutes)

1. Click **New file**
2. Type \`My first note\` (we’ll create \`My first note.md\`)
3. Write some Markdown, then click outside the editor to preview
4. Create a link: \`[[My first note]]\` or \`[[Another note]]\` and click it in preview

## Tips & shortcuts

- **Enter** confirms the create dialog (file/folder)
- **Ctrl+S / Cmd+S** saves immediately
- Auto-save triggers after ~1.2s of inactivity
- Click a **folder name** to select it (new files/folders will default there)
- Drag & drop a file onto a folder to move it

## Demo mode vs real vault

Demo mode is great for testing and automation, but it’s not meant for your real notes.

To work with your actual vault:

- Use **Choose local vault** (Chrome / Edge / Brave), or
- Run the local server with \`OBSIDIAN_VAULT=/path/to/vault npm start\`

---

Have fun exploring Browsidian.`;
  }

  function normalize(rel) {
    return (rel || "")
      .toString()
      .replaceAll("\\", "/")
      .replaceAll(/^\/+/g, "")
      .replaceAll(/\/+$/g, "");
  }

  function split(rel) {
    const s = normalize(rel);
    return s ? s.split(SEP).filter(Boolean) : [];
  }

  function parentDir(rel) {
    const parts = split(rel);
    parts.pop();
    return parts.join(SEP);
  }

  function basename(rel) {
    const parts = split(rel);
    return parts.length ? parts[parts.length - 1] : "";
  }

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return null;
      if (!parsed.files || typeof parsed.files !== "object") return null;
      if (!parsed.dirs || typeof parsed.dirs !== "object") return null;
      return parsed;
    } catch {
      return null;
    }
  }

  function save(data) {
    try {
      localStorage.setItem(KEY, JSON.stringify(data));
    } catch {}
  }

  function ensureSeed() {
    const existing = load();
    if (existing) {
      const files = existing.files || {};
      const currentWelcome = typeof files[WELCOME_PATH] === "string" ? files[WELCOME_PATH] : "";
      const isOldWelcome =
        currentWelcome && !currentWelcome.startsWith(WELCOME_UPGRADE_MARKER) && currentWelcome.startsWith("# Welcome");
      if (!currentWelcome || isOldWelcome) {
        existing.files[WELCOME_PATH] = defaultWelcomeMd();
        save(existing);
      }
      if (!existing.dirs || typeof existing.dirs !== "object") existing.dirs = { "": true };
      if (!existing.dirs[""]) existing.dirs[""] = true;
      return existing;
    }

    const seeded = { files: { [WELCOME_PATH]: defaultWelcomeMd() }, dirs: { "": true } };
    save(seeded);
    return seeded;
  }

  function mkdir(dirRel) {
    const data = ensureSeed();
    const p = normalize(dirRel);
    if (!p) return;
    const parts = split(p);
    let cur = "";
    for (const part of parts) {
      cur = cur ? `${cur}/${part}` : part;
      data.dirs[cur] = true;
    }
    save(data);
  }

  function listDir(dirRel) {
    const data = ensureSeed();
    const d = normalize(dirRel);
    const entries = [];

    const dirs = Object.keys(data.dirs || {});
    for (const p of dirs) {
      if (!p) continue;
      if (parentDir(p) !== d) continue;
      const name = basename(p);
      if (shouldIgnoreName(name)) continue;
      entries.push({ name, path: p, type: "dir" });
    }

    const files = Object.keys(data.files || {});
    for (const p of files) {
      if (parentDir(p) !== d) continue;
      const name = basename(p);
      if (shouldIgnoreName(name)) continue;
      entries.push({ name, path: p, type: "file" });
    }

    entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
    return entries;
  }

  function readFile(fileRel) {
    const data = ensureSeed();
    const p = normalize(fileRel);
    if (!p) throw new Error("Invalid file path");
    const content = data.files[p];
    if (typeof content !== "string") throw new Error("File not found");
    return content;
  }

  function writeFile(fileRel, content) {
    const data = ensureSeed();
    const p = normalize(fileRel);
    if (!p) throw new Error("Invalid file path");
    mkdir(parentDir(p));
    data.files[p] = (content ?? "").toString();
    save(data);
  }

  function deleteFile(fileRel) {
    const data = ensureSeed();
    const p = normalize(fileRel);
    if (!p) throw new Error("Invalid file path");
    if (!(p in data.files)) throw new Error("File not found");
    delete data.files[p];
    save(data);
  }

  function moveFile(fromRel, toRel) {
    const data = ensureSeed();
    const from = normalize(fromRel);
    const to = normalize(toRel);
    if (!from || !to) throw new Error("Invalid path");
    if (!(from in data.files)) throw new Error("File not found");
    if (to in data.files) throw new Error("Destination already exists");
    mkdir(parentDir(to));
    data.files[to] = data.files[from];
    delete data.files[from];
    save(data);
  }

  function clear() {
    try {
      localStorage.removeItem(KEY);
    } catch {}
  }

  return { listDir, readFile, writeFile, mkdir, deleteFile, moveFile, clear };
})();

async function tryGetPackageJsonVersion() {
  try {
    const res = await fetch("/package.json", { headers: { "Accept": "application/json" }, cache: "no-store" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return null;
    const v = (data?.version || "").toString().trim();
    return v || null;
  } catch {
    return null;
  }
}

function getEmbeddedAppVersion() {
  const meta = document.querySelector('meta[name="app-version"]');
  const v = (meta?.getAttribute("content") || "").trim();
  if (!v || v === "__APP_VERSION__") return null;
  return v;
}

function setAppVersion(version) {
  if (!appVersionEl) return;
  const v = (version || "").toString().trim();
  if (!v) {
    appVersionEl.textContent = "v—";
    return;
  }
  appVersionEl.textContent = v.startsWith("v") ? v : `v${v}`;
}

async function resolveAppVersion() {
  if (state.appVersion) return state.appVersion;

  // Prefer server-provided version when available.
  const cfg = await apiGet("/api/config").catch(() => null);
  const fromCfg = (cfg?.version || "").toString().trim();
  if (fromCfg) {
    state.appVersion = fromCfg;
    return fromCfg;
  }

  const embedded = getEmbeddedAppVersion();
  if (embedded) {
    state.appVersion = embedded;
    return embedded;
  }

  const fromPkg = await tryGetPackageJsonVersion();
  if (fromPkg) {
    state.appVersion = fromPkg;
    return fromPkg;
  }

  return null;
}

const vaultHandleStore = (() => {
  const DB_NAME = "obsidian-web";
  const STORE = "vault";
  const KEY = "rootHandle";

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function get() {
    const db = await openDb();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readonly");
        const store = tx.objectStore(STORE);
        const req = store.get(KEY);
        req.onsuccess = () => resolve(req.result ?? null);
        req.onerror = () => reject(req.error);
      });
    } finally {
      db.close();
    }
  }

  async function set(handle) {
    const db = await openDb();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        const store = tx.objectStore(STORE);
        const req = store.put(handle, KEY);
        req.onsuccess = () => resolve(true);
        req.onerror = () => reject(req.error);
      });
    } finally {
      db.close();
    }
  }

  async function clear() {
    const db = await openDb();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        const store = tx.objectStore(STORE);
        const req = store.delete(KEY);
        req.onsuccess = () => resolve(true);
        req.onerror = () => reject(req.error);
      });
    } finally {
      db.close();
    }
  }

  return { get, set, clear };
})();

function escapeHtml(s) {
  return (s ?? "")
    .toString()
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function safeHref(href) {
  const raw = (href || "").trim();
  if (!raw) return "";
  const lower = raw.toLowerCase();
  if (lower.startsWith("javascript:")) return "";
  if (lower.startsWith("data:")) return "";
  if (lower.startsWith("vbscript:")) return "";
  return raw;
}

function stripMdExtension(pathStr) {
  const s = (pathStr || "").toString();
  return s.toLowerCase().endsWith(".md") ? s.slice(0, -3) : s;
}

function hasExtension(pathStr) {
  const base = basenameOf(pathStr);
  return base.includes(".") && !base.startsWith(".");
}

async function ensureFileIndex() {
  if (state.fileIndex) return state.fileIndex;
  if (state.fileIndexPromise) return await state.fileIndexPromise;

  state.fileIndexPromise = (async () => {
    const index = new Map();
    const walk = async (dir) => {
      const entries = await listDir(dir);
      for (const entry of entries) {
        if (entry.type === "dir") {
          await walk(entry.path);
          continue;
        }
        if (entry.type !== "file") continue;
        const lower = entry.name.toLowerCase();
        if (!lower.endsWith(".md")) continue;
        const key = stripMdExtension(entry.name).toLowerCase();
        const existing = index.get(key);
        if (existing) existing.push(entry.path);
        else index.set(key, [entry.path]);
      }
    };
    await walk("");
    state.fileIndex = index;
    state.fileIndexPromise = null;
    return index;
  })();

  return await state.fileIndexPromise;
}

function invalidateFileIndex() {
  state.fileIndex = null;
  state.fileIndexPromise = null;
}

async function openWikiLinkTarget(target) {
  if (!state.activeFile) return;
  let t = (target || "").toString().trim();
  if (!t) return;
  t = t.replaceAll("\\", "/").replaceAll(/^\/+/g, "");
  t = t.split("#")[0].trim();
  if (!t) return;

  if (!hasExtension(t)) t += ".md";

  const currentDir = parentDirOf(state.activeFile);
  if (!t.includes("/")) {
    const sameDirCandidate = joinPath(normalizeDir(currentDir), t);
    try {
      await openFile(sameDirCandidate);
      return;
    } catch {}

    setStatus("Recherche du lien…");
    const index = await ensureFileIndex();
    const key = stripMdExtension(t).toLowerCase();
    const matches = index.get(key);
    if (matches && matches.length) {
      await openFile(matches[0]);
      return;
    }
    setStatus(`Link not found: [[${target}]]`);
    return;
  }

  await openFile(normalizeDir(t));
}

function renderMarkdownBasic(md) {
  const lines = (md ?? "").toString().replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  let i = 0;
  let html = "";
  let inCode = false;
  let codeFence = "";
  let listType = null; // "ul" | "ol"
  let inBlockquote = false;

  const closeList = () => {
    if (listType) html += `</${listType}>`;
    listType = null;
  };
  const closeBlockquote = () => {
    if (inBlockquote) html += "</blockquote>";
    inBlockquote = false;
  };

  const inline = (text) => {
    const tokens = [];
    const tokenFor = (htmlFragment) => {
      const id = `\u0000T${tokens.length}\u0000`;
      tokens.push({ id, html: htmlFragment });
      return id;
    };

    let s = (text ?? "").toString();

    // Inline code first to avoid parsing tags/links inside it.
    s = s.replaceAll(/`([^`]+)`/g, (_m, code) => tokenFor(`<code>${escapeHtml(code)}</code>`));

    s = s.replaceAll(/\[\[([^\]]+)\]\]/g, (_m, inner) => {
      const [left, ...rest] = (inner || "").split("|");
      const targetRaw = (left || "").trim();
      const labelRaw = (rest.length ? rest.join("|") : left || "").trim();
      const fileTarget = targetRaw.split("#")[0].trim();
      if (!fileTarget) return escapeHtml(labelRaw || targetRaw || "");
      const data = encodeURIComponent(fileTarget);
      const labelHtml = escapeHtml(labelRaw || targetRaw);
      return tokenFor(`<a href="#" data-wikilink="${escapeHtml(data)}">${labelHtml}</a>`);
    });

    // Obsidian tags: #tag or #tag/sub-tag
    s = s.replaceAll(/(^|[^A-Za-z0-9_\\/])#([A-Za-z0-9][A-Za-z0-9_\\/-]*)/g, (_m, prefix, tag) => {
      const t = (tag || "").trim();
      if (!t) return `${prefix}#`;
      const tagEsc = escapeHtml(t);
      return `${prefix}${tokenFor(`<span class="tag" data-tag="${tagEsc}">#${tagEsc}</span>`)}`;
    });

    s = escapeHtml(s);
    s = s.replaceAll(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replaceAll(/\*([^*]+)\*/g, "<em>$1</em>");
    s = s.replaceAll(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt, href) => {
      const safe = safeHref(href);
      if (!safe) return "";
      const srcEsc = escapeHtml(safe);
      const altEsc = escapeHtml((alt || "").toString());
      return `<img src="${srcEsc}" alt="${altEsc}" loading="lazy" />`;
    });
    s = s.replaceAll(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, href) => {
      const safe = safeHref(href);
      const labelEsc = label;
      if (!safe) return labelEsc;
      const hrefEsc = escapeHtml(safe);
      const rel = hrefEsc.startsWith("#") ? "" : ' rel="noreferrer noopener" target="_blank"';
      return `<a href="${hrefEsc}"${rel}>${labelEsc}</a>`;
    });

    for (const t of tokens) s = s.replaceAll(t.id, t.html);
    return s;
  };

  const isTableSeparator = (line) => {
    const s = (line || "").trim();
    if (!s.includes("|")) return false;
    const compact = s.replaceAll(/\s+/g, "");
    if (!/^[\|\-:\.]+$/.test(compact)) return false;
    // Require at least one dash group like --- between pipes.
    return /\-/.test(compact);
  };

  const parseTableRow = (line) => {
    let s = (line || "").trim();
    if (s.startsWith("|")) s = s.slice(1);
    if (s.endsWith("|")) s = s.slice(0, -1);
    return s.split("|").map((c) => c.trim());
  };

  const flushParagraph = (buf) => {
    if (!buf.length) return;
    html += `<p>${buf.map((l) => inline(l)).join("<br />")}</p>`;
    buf.length = 0;
  };

  const paragraph = [];

  while (i < lines.length) {
    const raw = lines[i];
    const line = raw;
    i += 1;

    const fenceMatch = line.match(/^```(.*)$/);
    if (fenceMatch) {
      flushParagraph(paragraph);
      closeList();
      closeBlockquote();
      if (!inCode) {
        inCode = true;
        codeFence = fenceMatch[1] || "";
        html += `<pre><code>`;
      } else {
        inCode = false;
        codeFence = "";
        html += `</code></pre>`;
      }
      continue;
    }

    if (inCode) {
      html += `${escapeHtml(line)}\n`;
      continue;
    }

    if (/^\s*$/.test(line)) {
      flushParagraph(paragraph);
      closeList();
      closeBlockquote();
      continue;
    }

    if (/^---\s*$/.test(line) || /^\*\*\*\s*$/.test(line)) {
      flushParagraph(paragraph);
      closeList();
      closeBlockquote();
      html += "<hr />";
      continue;
    }

    const bq = line.match(/^>\s?(.*)$/);
    if (bq) {
      flushParagraph(paragraph);
      closeList();
      if (!inBlockquote) {
        inBlockquote = true;
        html += "<blockquote>";
      }
      html += `<p>${inline(bq[1])}</p>`;
      continue;
    } else {
      closeBlockquote();
    }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flushParagraph(paragraph);
      closeList();
      const level = heading[1].length;
      html += `<h${level}>${inline(heading[2].trim())}</h${level}>`;
      continue;
    }

    // Tables (GitHub/Obsidian style): header row + separator row.
    if (line.includes("|") && i < lines.length && isTableSeparator(lines[i])) {
      flushParagraph(paragraph);
      closeList();
      closeBlockquote();

      const headerCells = parseTableRow(line);
      const sepCells = parseTableRow(lines[i]);
      i += 1;

      const colCount = Math.max(headerCells.length, sepCells.length);
      const header = Array.from({ length: colCount }, (_, idx) => headerCells[idx] ?? "");

      html += "<table><thead><tr>";
      for (const cell of header) html += `<th>${inline(cell)}</th>`;
      html += "</tr></thead><tbody>";

      while (i < lines.length) {
        const rowLine = lines[i];
        if (/^\s*$/.test(rowLine)) break;
        if (!rowLine.includes("|")) break;
        if (isTableSeparator(rowLine)) break;
        const rowCells = parseTableRow(rowLine);
        html += "<tr>";
        for (let c = 0; c < colCount; c += 1) html += `<td>${inline(rowCells[c] ?? "")}</td>`;
        html += "</tr>";
        i += 1;
      }

      html += "</tbody></table>";
      continue;
    }

    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ol) {
      flushParagraph(paragraph);
      if (listType && listType !== "ol") closeList();
      if (!listType) listType = "ol", (html += "<ol>");
      html += `<li>${inline(ol[1])}</li>`;
      continue;
    }

    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    if (ul) {
      flushParagraph(paragraph);
      if (listType && listType !== "ul") closeList();
      if (!listType) listType = "ul", (html += "<ul>");
      html += `<li>${inline(ul[1])}</li>`;
      continue;
    }

    closeList();
    paragraph.push(line.trim());
  }

  flushParagraph(paragraph);
  closeList();
  closeBlockquote();
  if (inCode) html += `</code></pre>`;
  if (!html) return `<div class="muted">Empty document. Click to edit…</div>`;
  return html;
}

function showPreview() {
  editorEl.hidden = true;
  previewEl.hidden = false;
  const content = state.activeFile ? editorEl.value : "";
  const isMd = state.activeFile ? state.activeFile.toLowerCase().endsWith(".md") : false;
  previewEl.innerHTML = state.activeFile
    ? isMd
      ? renderMarkdownBasic(content)
      : `<div class="muted">File not supported</div>`
    : `<div class="muted">Select a file on the left…</div>`;
}

function showEditor({ focus } = { focus: true }) {
  if (!state.activeFile) return;
  if (!state.activeFile.toLowerCase().endsWith(".md")) return;
  previewEl.hidden = true;
  editorEl.hidden = false;
  if (focus) editorEl.focus();
}

function showVaultModal() {
  if (!vaultDialog) return;
  if (vaultDialog.open) return;
  const supported = "showDirectoryPicker" in window;
  if (vaultChooseBtn) {
    vaultChooseBtn.disabled = !supported;
    vaultChooseBtn.textContent = supported ? "Choose local vault" : "Choose local vault (Chrome/Edge/Brave)";
  }
  vaultDialog.showModal();
}

async function openDemoVault() {
  if (state.dirty) {
    const ok = confirm("You have unsaved changes. Continue without saving?");
    if (!ok) return;
  }
  setStatus("Opening demo vault…");
  state.rootHandle = null;
  state.vaultLabel = "Demo (local)";
  setMode("demo");
  setAppVersion(state.appVersion || getEmbeddedAppVersion() || (await tryGetPackageJsonVersion()));
  vaultNameEl.textContent = `Vault: ${state.vaultLabel}`;
  setVaultUiEnabled(true);
  resetUiState();
  await ensureDirLoaded("");
  renderTree();
  await openFile("Welcome.md").catch(() => {});
  setStatus("Ready.");
  if (vaultDialog?.open) vaultDialog.close();
}

async function openDropboxVault() {
  const cfg = await dropboxGetConfig();
  if (!cfg?.appKey) {
    alert("Dropbox is not configured on this server. Set DROPBOX_APP_KEY and DROPBOX_APP_SECRET (and redirect URI).");
    return;
  }
  if (state.dirty) {
    const ok = confirm("You have unsaved changes. Continue without saving?");
    if (!ok) return;
  }

  const redirectUri = cfg.redirectUri || `${window.location.origin}/dropbox-oauth.html`;
  if (cfg.redirectUri && !redirectUri.startsWith(window.location.origin)) {
    alert(`Invalid DROPBOX_REDIRECT_URI (must match this origin):\n\n${window.location.origin}`);
    return;
  }

  const noticeKey = `dropboxRedirectNotice:${redirectUri}`;
  if (!localStorage.getItem(noticeKey)) {
    const ok = confirm(
      `Dropbox redirect URI must be configured in your Dropbox app settings.\n\nAdd this redirect URI:\n${redirectUri}\n\nContinue?`
    );
    if (!ok) return;
    try {
      localStorage.setItem(noticeKey, "1");
    } catch {}
  }

  const oauthState = randomString(16);
  const codeVerifier = randomString(64);
  const codeChallenge = await sha256Base64Url(codeVerifier);
  sessionStorage.setItem("dropboxOauthState", oauthState);
  sessionStorage.setItem("dropboxCodeVerifier", codeVerifier);

  const authorizeUrl =
    `https://www.dropbox.com/oauth2/authorize` +
    `?client_id=${encodeURIComponent(cfg.appKey)}` +
    `&response_type=code` +
    `&token_access_type=offline` +
    `&code_challenge_method=S256` +
    `&code_challenge=${encodeURIComponent(codeChallenge)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${encodeURIComponent(oauthState)}`;

  setStatus("Opening Dropbox auth…");
  const w = 520;
  const h = 680;
  const left = Math.max(0, Math.round(window.screenX + (window.outerWidth - w) / 2));
  const top = Math.max(0, Math.round(window.screenY + (window.outerHeight - h) / 2));
  const popup = window.open(authorizeUrl, "dropbox-oauth", `width=${w},height=${h},left=${left},top=${top}`);
  if (!popup) {
    alert("Popup blocked. Please allow popups and try again.");
    setStatus("Popup blocked.");
    return;
  }

  if (vaultDialog?.open) vaultDialog.close();
}

function setVaultUiEnabled(enabled) {
  const on = Boolean(enabled);
  if (searchEl) searchEl.hidden = !on;
  if (createActionsEl) createActionsEl.hidden = !on;
}

function hideContextMenu() {
  if (!contextMenuEl) return;
  contextMenuEl.hidden = true;
  contextMenuEl.style.left = "0px";
  contextMenuEl.style.top = "0px";
  contextMenuEl.dataset.path = "";
}

function showContextMenu({ x, y, path }) {
  if (!contextMenuEl) return;
  contextMenuEl.hidden = false;
  contextMenuEl.dataset.path = path || "";

  const padding = 8;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  contextMenuEl.style.left = "0px";
  contextMenuEl.style.top = "0px";
  const rect = contextMenuEl.getBoundingClientRect();
  const left = Math.min(Math.max(padding, x), vw - rect.width - padding);
  const top = Math.min(Math.max(padding, y), vh - rect.height - padding);
  contextMenuEl.style.left = `${left}px`;
  contextMenuEl.style.top = `${top}px`;
}

function applyTheme(theme) {
  const t = theme === "light" ? "light" : "dark";
  if (t === "light") document.documentElement.dataset.theme = "light";
  else delete document.documentElement.dataset.theme;
  if (themeToggleEl) themeToggleEl.checked = t === "light";
  try {
    localStorage.setItem("theme", t);
  } catch {}
}

function setMode(nextMode) {
  state.mode = nextMode;
  selectVaultBtn.disabled = false;
  const setIconBtn = (btn, { label, title }) => {
    if (!btn) return;
    const labelEl = btn.querySelector(".icon-btn-label");
    if (labelEl) labelEl.textContent = label;
    else btn.textContent = label;
    if (typeof title === "string") {
      btn.title = title;
      btn.setAttribute("aria-label", title);
    }
  };

  if (nextMode === "browser") setIconBtn(selectVaultBtn, { label: "Change", title: "Change local vault" });
  else if (nextMode === "demo") setIconBtn(selectVaultBtn, { label: "Reset", title: "Reset demo vault" });
  else if (nextMode === "dropbox") setIconBtn(selectVaultBtn, { label: "Change", title: "Change Dropbox vault" });
  else setIconBtn(selectVaultBtn, { label: "Choose", title: "Choose local vault" });

  useServerBtn.hidden = nextMode === "server";
  if (nextMode === "demo") setIconBtn(useServerBtn, { label: "Exit", title: "Exit demo" });
  else setIconBtn(useServerBtn, { label: "Disconnect", title: "Disconnect" });
}

function setDirty(isDirty) {
  state.dirty = isDirty;
  dirtyEl.hidden = !isDirty;
  saveBtn.disabled = !state.activeFile || !isDirty;
}

function setActivePath(path) {
  currentPathEl.textContent = path || "—";
}

async function apiGet(url) {
  const res = await fetch(url, { headers: { "Accept": "application/json" } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function apiSend(method, url, payload) {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function shouldIgnoreName(name) {
  if (!name) return true;
  if (name === ".DS_Store") return true;
  return IGNORED_DIRS.has(name);
}

function joinPath(a, b) {
  if (!a) return b;
  if (!b) return a;
  return `${a}/${b}`;
}

function splitPath(relPath) {
  return (relPath || "")
    .replaceAll("\\", "/")
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function getDirHandleByPath(dirRel, { create } = { create: false }) {
  if (!state.rootHandle) throw new Error("No local vault selected");
  let current = state.rootHandle;
  for (const part of splitPath(dirRel)) {
    current = await current.getDirectoryHandle(part, { create: Boolean(create) });
  }
  return current;
}

async function getFileHandleByPath(fileRel, { create } = { create: false }) {
  const parts = splitPath(fileRel);
  const filename = parts.pop();
  if (!filename) throw new Error("Chemin de fichier invalide");
  const parentDir = parts.length ? parts.join("/") : "";
  const dirHandle = await getDirHandleByPath(parentDir, { create: Boolean(create) });
  return await dirHandle.getFileHandle(filename, { create: Boolean(create) });
}

async function listDirBrowser(dirRel) {
  const dirHandle = await getDirHandleByPath(dirRel, { create: false });
  const entries = [];
  for await (const [name, handle] of dirHandle.entries()) {
    if (shouldIgnoreName(name)) continue;
    const relPath = joinPath(normalizeDir(dirRel), name);
    if (handle.kind === "directory") entries.push({ name, path: relPath, type: "dir" });
    else entries.push({ name, path: relPath, type: "file" });
  }
  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
  return entries;
}

async function listDirDropbox(dirRel) {
  const dbxPath = dropboxPathFor(normalizeDir(dirRel));
  const data = await dropboxApiJson("list", { path: dbxPath });
  const entries = [];
  for (const ent of data.entries || []) {
    const tag = ent[".tag"];
    const name = ent.name;
    if (shouldIgnoreName(name)) continue;
    if (tag === "folder") {
      const relPath = joinPath(normalizeDir(dirRel), name);
      entries.push({ name, path: relPath, type: "dir" });
    } else if (tag === "file") {
      const relPath = joinPath(normalizeDir(dirRel), name);
      entries.push({ name, path: relPath, type: "file" });
    }
  }
  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
  return entries;
}

async function readFileBrowser(fileRel) {
  const handle = await getFileHandleByPath(fileRel, { create: false });
  const file = await handle.getFile();
  return await file.text();
}

async function readFileDropbox(fileRel) {
  const dbxPath = dropboxPathFor(fileRel);
  return await dropboxDownloadText(dbxPath);
}

async function writeFileBrowser(fileRel, content) {
  const handle = await getFileHandleByPath(fileRel, { create: true });
  const writable = await handle.createWritable();
  await writable.write(content);
  await writable.close();
}

async function writeFileDropbox(fileRel, content) {
  const dbxPath = dropboxPathFor(fileRel);
  await dropboxUploadText(dbxPath, content);
}

async function mkdirBrowser(dirRel) {
  await getDirHandleByPath(dirRel, { create: true });
}

async function mkdirDropbox(dirRel) {
  const dbxPath = dropboxPathFor(normalizeDir(dirRel));
  await dropboxApiJson("mkdir", { path: dbxPath });
}

async function listDir(dirRel) {
  const d = normalizeDir(dirRel);
  if (state.mode === "demo") return demoVaultStore.listDir(d);
  if (state.mode === "dropbox") return await listDirDropbox(d);
  if (state.mode === "browser") return await listDirBrowser(d);
  const data = await apiGet(`/api/list?dir=${encodeURIComponent(d)}`);
  return data.entries;
}

async function readFile(rel) {
  if (state.mode === "demo") return demoVaultStore.readFile(rel);
  if (state.mode === "dropbox") return await readFileDropbox(rel);
  if (state.mode === "browser") return await readFileBrowser(rel);
  const data = await apiGet(`/api/read?path=${encodeURIComponent(rel)}`);
  return data.content;
}

async function writeFile(rel, content) {
  if (state.mode === "demo") return demoVaultStore.writeFile(rel, content);
  if (state.mode === "dropbox") return await writeFileDropbox(rel, content);
  if (state.mode === "browser") return await writeFileBrowser(rel, content);
  await apiSend("PUT", "/api/write", { path: rel, content });
}

async function mkdir(rel) {
  if (state.mode === "demo") return demoVaultStore.mkdir(rel);
  if (state.mode === "dropbox") return await mkdirDropbox(rel);
  if (state.mode === "browser") return await mkdirBrowser(rel);
  await apiSend("POST", "/api/mkdir", { path: rel });
}

function basenameOf(relPath) {
  const s = (relPath || "").replaceAll(/\/+$/g, "");
  const idx = s.lastIndexOf("/");
  return idx === -1 ? s : s.slice(idx + 1);
}

async function pathExistsBrowser(relPath) {
  try {
    const parts = splitPath(relPath);
    if (parts.length === 0) return true;
    const name = parts.pop();
    const parent = parts.length ? parts.join("/") : "";
    const dir = await getDirHandleByPath(parent, { create: false });
    // Try directory first, then file.
    try {
      await dir.getDirectoryHandle(name, { create: false });
      return true;
    } catch {}
    try {
      await dir.getFileHandle(name, { create: false });
      return true;
    } catch {}
    return false;
  } catch {
    return false;
  }
}

async function deleteFileBrowser(fileRel) {
  const parts = splitPath(fileRel);
  const name = parts.pop();
  if (!name) throw new Error("Invalid file path");
  const parent = parts.length ? parts.join("/") : "";
  const dir = await getDirHandleByPath(parent, { create: false });
  await dir.removeEntry(name);
}

async function deleteFilePath(fileRel) {
  if (state.mode === "demo") {
    demoVaultStore.deleteFile(fileRel);
    return;
  }
  if (state.mode === "dropbox") {
    const dbxPath = dropboxPathFor(fileRel);
    await dropboxApiJson("delete", { path: dbxPath });
    return;
  }
  if (state.mode === "browser") {
    await deleteFileBrowser(fileRel);
    return;
  }
  await apiSend("POST", "/api/delete", { path: fileRel });
}

async function moveFilePath(fromRel, toRel) {
  if (fromRel === toRel) return;
  if (state.mode === "demo") {
    demoVaultStore.moveFile(fromRel, toRel);
    return;
  }
  if (state.mode === "dropbox") {
    const fromPath = dropboxPathFor(fromRel);
    const toPath = dropboxPathFor(toRel);
    await dropboxApiJson("move", { fromPath, toPath });
    return;
  }
  if (state.mode === "browser") {
    const exists = await pathExistsBrowser(toRel);
    if (exists) throw new Error("Destination already exists");
    const content = await readFileBrowser(fromRel);
    await writeFileBrowser(toRel, content);
    await deleteFileBrowser(fromRel);
    return;
  }
  await apiSend("POST", "/api/move", { from: fromRel, to: toRel });
}

function iconFor(entry) {
  if (entry.type === "dir") return state.expandedDirs.has(entry.path) ? "i-chevron-down" : "i-chevron-right";
  return "i-file-text";
}

function normalizeDir(dir) {
  if (!dir || dir === "/") return "";
  return dir.replaceAll(/\/+$/g, "");
}

async function ensureDirLoaded(dir) {
  const d = normalizeDir(dir);
  if (state.childrenByDir.has(d)) return;
  const entries = await listDir(d);
  state.childrenByDir.set(d, entries);
}

function passesFilter(entry) {
  const q = state.filter.trim().toLowerCase();
  if (!q) return true;
  return entry.path.toLowerCase().includes(q);
}

function renderTree() {
  treeEl.innerHTML = "";
  const rootChildren = state.childrenByDir.get("") || [];
  const frag = document.createDocumentFragment();

  const selectedDir = normalizeDir(state.selectedDir || "");

  const renderDirChildren = (dir, container) => {
    const entries = state.childrenByDir.get(dir) || [];
    for (const entry of entries) {
      if (!passesFilter(entry)) {
        if (entry.type === "dir" && hasAnyChildMatching(entry.path)) {
          // keep
        } else {
          continue;
        }
      }

      const row = document.createElement("div");
      row.className = "tree-item";
      row.setAttribute("role", "treeitem");
      row.dataset.path = entry.path;
      row.dataset.type = entry.type;
      if (entry.type === "file") {
        row.draggable = true;
        row.setAttribute("draggable", "true");
      }

      if (entry.type === "file" && entry.path === state.activeFile) row.classList.add("active");
      if (entry.type === "dir" && entry.path === selectedDir) row.classList.add("selected");

      const icon = document.createElement("div");
      icon.className = "icon";
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("class", "icon-svg");
      svg.setAttribute("aria-hidden", "true");
      const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
      use.setAttribute("href", `#${iconFor(entry)}`);
      svg.appendChild(use);
      icon.appendChild(svg);

      const name = document.createElement("div");
      name.className = "name";
      name.textContent = entry.name;

      row.appendChild(icon);
      row.appendChild(name);
      container.appendChild(row);

      if (entry.type === "dir") {
        const childrenWrap = document.createElement("div");
        childrenWrap.className = "tree-children";
        childrenWrap.hidden = !state.expandedDirs.has(entry.path);
        container.appendChild(childrenWrap);
        if (state.expandedDirs.has(entry.path)) renderDirChildren(entry.path, childrenWrap);
      }
    }
  };

  renderDirChildren("", frag);
  treeEl.appendChild(frag);
}

function hasAnyChildMatching(dir) {
  const entries = state.childrenByDir.get(dir);
  if (!entries) return false;
  const q = state.filter.trim().toLowerCase();
  if (!q) return true;
  for (const entry of entries) {
    if (entry.path.toLowerCase().includes(q)) return true;
    if (entry.type === "dir" && hasAnyChildMatching(entry.path)) return true;
  }
  return false;
}

async function toggleDir(dir) {
  const d = normalizeDir(dir);
  if (state.expandedDirs.has(d)) {
    state.expandedDirs.delete(d);
    renderTree();
    return;
  }
  setStatus(`Loading: ${d || "/"}`);
  await ensureDirLoaded(d);
  state.expandedDirs.add(d);
  setStatus("Ready.");
  renderTree();
}

async function openFile(filePath) {
  if (!filePath) return;
  if (state.dirty) {
    const ok = confirm("You have unsaved changes. Continue without saving?");
    if (!ok) return;
  }
  clearAutosaveTimer();
  setStatus(`Opening: ${filePath}`);
  const content = await readFile(filePath);
  state.activeFile = filePath;
  state.selectedDir = parentDirOf(filePath);
  state.activeFileContent = content;
  editorEl.value = content;
  setActivePath(filePath);
  setDirty(false);
  showPreview();
  setStatus("Ready.");
  renderTree();
}

async function saveCurrent() {
  if (!state.activeFile) return;
  setStatus("Saving…");
  await writeFile(state.activeFile, editorEl.value);
  state.activeFileContent = editorEl.value;
  setDirty(false);
  setStatus("Saved.");
  showPreview();
}

function clearAutosaveTimer() {
  if (state.autosaveTimer) window.clearTimeout(state.autosaveTimer);
  state.autosaveTimer = null;
}

function scheduleAutosave() {
  if (!state.activeFile) return;
  if (!state.dirty) return;
  clearAutosaveTimer();
  state.autosaveTimer = window.setTimeout(() => {
    state.autosaveTimer = null;
    void autosaveNow();
  }, AUTOSAVE_DELAY_MS);
}

async function autosaveNow() {
  if (!state.activeFile) return;
  if (!state.dirty) return;
  if (state.autosaveInFlight) {
    state.autosaveQueued = true;
    return;
  }
  state.autosaveInFlight = true;
  try {
    setStatus("Auto-saving…");
    await writeFile(state.activeFile, editorEl.value);
    state.activeFileContent = editorEl.value;
    setDirty(false);
    setStatus("Auto-saved.");
    if (document.activeElement !== editorEl) showPreview();
  } catch (err) {
    setStatus(`Auto-save error: ${err.message}`);
  } finally {
    state.autosaveInFlight = false;
    if (state.autosaveQueued) {
      state.autosaveQueued = false;
      scheduleAutosave();
    }
  }
}

function showPrompt({ title, label, help, placeholder, value }) {
  promptTitle.textContent = title;
  promptLabel.textContent = label;
  promptHelp.textContent = help || "";
  promptInput.value = value || "";
  promptInput.placeholder = placeholder || "";
  promptDialog.showModal();
  promptInput.focus();
  const len = promptInput.value.length;
  if (promptInput.value.endsWith("/")) {
    promptInput.setSelectionRange(len, len);
  } else {
    promptInput.select();
  }
  return new Promise((resolve) => {
    const onKeyDown = (e) => {
      if (e.isComposing) return;
      if (e.key !== "Enter") return;
      if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
      e.preventDefault();
      promptDialog.close("ok");
    };
    promptInput.addEventListener("keydown", onKeyDown);
    promptDialog.addEventListener(
      "close",
      () => {
        promptInput.removeEventListener("keydown", onKeyDown);
        const ok = promptDialog.returnValue === "ok";
        resolve(ok ? promptInput.value : null);
      },
      { once: true }
    );
  });
}

function dropboxDisplayPath(pathStr) {
  return pathStr ? pathStr : "/";
}

function dropboxParentPath(pathStr) {
  const s = normalizeDropboxRootPath(pathStr);
  if (!s) return "";
  const idx = s.lastIndexOf("/");
  if (idx <= 0) return "";
  return s.slice(0, idx);
}

function dropboxJoinPath(parentPath, childName) {
  const base = normalizeDropboxRootPath(parentPath);
  const name = (childName ?? "").toString().trim().replaceAll("\\", "/");
  if (!name) return base;
  if (name.startsWith("/")) return normalizeDropboxRootPath(name);
  return normalizeDropboxRootPath(base ? `${base}/${name}` : `/${name}`);
}

function dropboxPathSegments(pathStr) {
  const s = normalizeDropboxRootPath(pathStr);
  if (!s) return [];
  return s.replaceAll(/^\/+/g, "").split("/").filter(Boolean);
}

function renderDropboxBreadcrumb(currentPath, { onNavigate }) {
  if (!dropboxPathBreadcrumb) return;
  const crumbs = [{ label: "/", path: "" }];
  const segments = dropboxPathSegments(currentPath);
  let acc = "";
  for (const seg of segments) {
    acc = dropboxJoinPath(acc, seg);
    crumbs.push({ label: seg, path: acc });
  }

  dropboxPathBreadcrumb.innerHTML = "";
  for (const c of crumbs) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "dbx-crumb";
    btn.textContent = c.label;
    btn.addEventListener("click", () => onNavigate?.(c.path));
    dropboxPathBreadcrumb.appendChild(btn);
  }
}

function showDropboxPathPicker({ initialPath } = {}) {
  if (!dropboxPathDialog || !dropboxPathInput || !dropboxPathList) {
    return showPrompt({
      title: "Dropbox vault",
      label: "Folder path in Dropbox (optional)",
      help: "Example: /Apps/ObsidianVault (leave empty for root).",
      placeholder: "/Apps/ObsidianVault",
      value: initialPath || ""
    }).then((v) => (v === null ? null : normalizeDropboxRootPath(v)));
  }

  const form = dropboxPathDialog.querySelector("form");
  const selectBtn = dropboxPathSelectBtn || dropboxPathDialog.querySelector("#dropboxPathSelectBtn");
  let currentPath = normalizeDropboxRootPath(initialPath);
  let selectedPath = currentPath;
  let chosenPath = null;
  let busy = false;
  let lastError = "";

  function setHelp(text) {
    if (!dropboxPathHelp) return;
    dropboxPathHelp.textContent = text;
  }

  function setInput(pathStr) {
    dropboxPathInput.value = dropboxDisplayPath(pathStr);
  }

  function setSelected(nextSelected) {
    selectedPath = normalizeDropboxRootPath(nextSelected);
    for (const el of dropboxPathList.querySelectorAll(".dbx-item")) {
      const p = normalizeDropboxRootPath(el.dataset.path || "");
      el.classList.toggle("selected", p === selectedPath);
    }
    setInput(selectedPath);
  }

  function renderItems(entries) {
    dropboxPathList.innerHTML = "";

    if (lastError) {
      const msg = document.createElement("div");
      msg.className = "dbx-item dbx-muted";
      msg.textContent = lastError;
      dropboxPathList.appendChild(msg);
      return;
    }

    if (!entries.length) {
      const msg = document.createElement("div");
      msg.className = "dbx-item dbx-muted";
      msg.textContent = "No subfolders.";
      dropboxPathList.appendChild(msg);
      return;
    }

    for (const f of entries) {
      const item = document.createElement("div");
      item.className = "dbx-item";
      item.setAttribute("role", "option");
      item.dataset.path = f.path;

      const icon = document.createElement("div");
      icon.className = "dbx-item-icon";
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("class", "icon-svg");
      svg.setAttribute("aria-hidden", "true");
      const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
      use.setAttribute("href", "#i-chevron-right");
      svg.appendChild(use);
      icon.appendChild(svg);

      const name = document.createElement("div");
      name.className = "dbx-item-name";
      name.textContent = f.name;

      item.appendChild(icon);
      item.appendChild(name);

      item.addEventListener("click", () => setSelected(f.path));
      item.addEventListener("dblclick", async () => {
        if (busy) return;
        currentPath = normalizeDropboxRootPath(f.path);
        lastError = "";
        setInput(currentPath);
        setSelected(currentPath);
        await load();
      });

      dropboxPathList.appendChild(item);
    }

    setSelected(selectedPath);
  }

  async function load() {
    busy = true;
    setHelp("Loading folders…");
    if (dropboxPathUpBtn) dropboxPathUpBtn.disabled = currentPath === "";
    if (dropboxPathNewBtn) dropboxPathNewBtn.disabled = true;
    dropboxPathList.innerHTML = "";

    try {
      const data = await dropboxApiJson("list", { path: currentPath });
      const folders = (data?.entries || [])
        .filter((e) => e && typeof e === "object" && e[".tag"] === "folder")
        .map((e) => ({
          name: (e.name || "").toString(),
          path: normalizeDropboxRootPath((e.path_display || e.path_lower || "").toString())
        }))
        .filter((e) => e.name && typeof e.path === "string")
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

      lastError = "";
      renderDropboxBreadcrumb(currentPath, {
        onNavigate: async (p) => {
          if (busy) return;
          currentPath = normalizeDropboxRootPath(p);
          lastError = "";
          setInput(currentPath);
          setSelected(currentPath);
          await load();
        }
      });
      renderItems(folders);
      setHelp("Select a folder for your vault (this is a Dropbox path, not a local path).");
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      lastError = `Error: ${msg}`;
      renderDropboxBreadcrumb(currentPath, { onNavigate: () => {} });
      renderItems([]);
      setHelp("Could not list folders.");
    } finally {
      busy = false;
      if (dropboxPathUpBtn) dropboxPathUpBtn.disabled = currentPath === "";
      if (dropboxPathNewBtn) dropboxPathNewBtn.disabled = false;
    }
  }

  async function ensureFolderExists(targetPath) {
    try {
      await dropboxApiJson("list", { path: targetPath });
      return true;
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      if (targetPath && msg.includes("path/not_found")) {
        const create = confirm(`Dropbox folder not found:\n${targetPath}\n\nCreate it?`);
        if (!create) return false;
        await dropboxApiJson("mkdir", { path: targetPath });
        await dropboxApiJson("list", { path: targetPath });
        return true;
      }
      alert(`Dropbox folder error:\n${msg}`);
      return false;
    }
  }

  dropboxPathDialog.showModal();
  renderDropboxBreadcrumb(currentPath, { onNavigate: () => {} });
  setInput(currentPath);
  setSelected(currentPath);
  dropboxPathInput.focus();
  const len = dropboxPathInput.value.length;
  dropboxPathInput.setSelectionRange(len, len);

  load().catch(() => {});

  return new Promise((resolve) => {
    const attemptSelect = async () => {
      if (busy) return;
      const raw = dropboxPathInput.value;
      const target = normalizeDropboxRootPath(raw === "/" ? "" : raw);
      const ok = await ensureFolderExists(target);
      if (!ok) return;
      chosenPath = target;
      dropboxPathDialog.close("ok");
    };

    const onUp = async () => {
      if (busy) return;
      currentPath = dropboxParentPath(currentPath);
      lastError = "";
      setInput(currentPath);
      setSelected(currentPath);
      await load();
    };

    const onNew = async () => {
      if (busy) return;
      const name = await showPrompt({
        title: "New Dropbox folder",
        label: "Folder name",
        help: `Create a folder under ${dropboxDisplayPath(currentPath)}`,
        placeholder: "New folder",
        value: ""
      });
      if (!name) return;
      const newPath = dropboxJoinPath(currentPath, name);
      try {
        await dropboxApiJson("mkdir", { path: newPath });
        currentPath = normalizeDropboxRootPath(newPath);
        lastError = "";
        setInput(currentPath);
        setSelected(currentPath);
        await load();
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        alert(`Failed to create folder:\n${msg}`);
      }
    };

    const onInput = () => {
      const raw = dropboxPathInput.value;
      const normalized = normalizeDropboxRootPath(raw === "/" ? "" : raw);
      selectedPath = normalized;
    };

    const onSubmit = async (e) => {
      const submitter = e.submitter;
      const rv = (submitter?.getAttribute?.("value") || "").toString();
      if (rv !== "ok") return;
      e.preventDefault();
      await attemptSelect();
    };

    const onKeyDown = async (e) => {
      if (e.isComposing) return;
      if (e.key !== "Enter") return;
      if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
      e.preventDefault();
      if (selectBtn) {
        selectBtn.focus();
      }
      await attemptSelect();
    };

    dropboxPathUpBtn?.addEventListener("click", onUp);
    dropboxPathNewBtn?.addEventListener("click", onNew);
    dropboxPathInput.addEventListener("input", onInput);
    dropboxPathInput.addEventListener("keydown", onKeyDown);
    form?.addEventListener("submit", onSubmit);

    dropboxPathDialog.addEventListener(
      "close",
      () => {
        dropboxPathUpBtn?.removeEventListener("click", onUp);
        dropboxPathNewBtn?.removeEventListener("click", onNew);
        dropboxPathInput.removeEventListener("input", onInput);
        dropboxPathInput.removeEventListener("keydown", onKeyDown);
        form?.removeEventListener("submit", onSubmit);
        const ok = dropboxPathDialog.returnValue === "ok";
        resolve(ok ? chosenPath ?? selectedPath : null);
      },
      { once: true }
    );
  });
}

function parentDirOf(pathStr) {
  const s = (pathStr || "").replaceAll(/\/+$/g, "");
  const idx = s.lastIndexOf("/");
  return idx === -1 ? "" : s.slice(0, idx);
}

function setSelectedDir(dirRel) {
  state.selectedDir = normalizeDir(dirRel);
  renderTree();
}

function clearActiveFile() {
  clearAutosaveTimer();
  state.activeFile = null;
  state.activeFileContent = "";
  editorEl.value = "";
  setActivePath("");
  setDirty(false);
  showPreview();
}

async function selectFolder(dirRel) {
  if (state.dirty) {
    const ok = confirm("You have unsaved changes. Continue without saving?");
    if (!ok) return;
  }
  if (state.activeFile) clearActiveFile();
  setSelectedDir(dirRel);
  setStatus("Ready.");
}

async function createFolder() {
  const base = normalizeDir((state.selectedDir ?? (state.activeFile ? parentDirOf(state.activeFile) : "")) || "");
  const rel = await showPrompt({
    title: "New folder",
    label: "Path (relative to the vault)",
    help: "Example: Notes/Projects",
    placeholder: base ? `${base}/New folder` : "New folder",
    value: base ? `${base}/` : ""
  });
  if (!rel) return;
  setStatus("Creating folder…");
  await mkdir(rel);
  invalidateFileIndex();
  const parent = parentDirOf(rel);
  state.childrenByDir.delete(parent);
  await ensureDirLoaded(parent);
  state.expandedDirs.add(parent);
  setStatus("Folder created.");
  renderTree();
}

async function createFile() {
  const base = normalizeDir((state.selectedDir ?? (state.activeFile ? parentDirOf(state.activeFile) : "")) || "");
  const rel = await showPrompt({
    title: "New file",
    label: "Path (relative to the vault)",
    help: "Example: Notes/my-note.md",
    placeholder: base ? `${base}/new.md` : "new.md",
    value: base ? `${base}/` : ""
  });
  if (!rel) return;
  const trimmed = rel.trim();
  const baseName = basenameOf(trimmed);
  const lower = trimmed.toLowerCase();
  let finalPath = trimmed;

  if (!lower.endsWith(".md")) {
    if (baseName.includes(".")) {
      alert("Only .md files are allowed.");
      setStatus("Error: only .md files are allowed.");
      return;
    }
    finalPath = `${trimmed}.md`;
  }

  setStatus("Creating file…");
  await writeFile(finalPath, "");
  invalidateFileIndex();
  const parent = parentDirOf(finalPath);
  state.childrenByDir.delete(parent);
  await ensureDirLoaded(parent);
  state.expandedDirs.add(parent);
  setStatus("File created.");
  renderTree();
  await openFile(finalPath);
}

treeEl.addEventListener("click", async (e) => {
  const row = e.target.closest(".tree-item");
  if (!row) return;
  const type = row.dataset.type;
  const p = row.dataset.path;
  const clickedIcon = Boolean(e.target.closest(".icon"));
  try {
    if (type === "dir") {
      if (clickedIcon) await toggleDir(p);
      else await selectFolder(p);
      return;
    }
    await openFile(p);
  } catch (err) {
    setStatus(`Error: ${err.message}`);
  }
});

function clearDropTargets() {
  treeEl.querySelectorAll(".tree-item.drop-target").forEach((el) => el.classList.remove("drop-target"));
}

treeEl.addEventListener("dragstart", (e) => {
  const row = e.target.closest(".tree-item");
  if (!row) return;
  if (row.dataset.type !== "file") return;
  state.draggingPath = row.dataset.path;
  const dt = e.dataTransfer;
  if (!dt) return;
  dt.effectAllowed = "move";
  try {
    dt.setData("text/plain", row.dataset.path);
  } catch {}
  try {
    dt.setData("text", row.dataset.path);
  } catch {}
  try {
    dt.setData("application/x-obsidian-web-path", row.dataset.path);
  } catch {}
});

treeEl.addEventListener("dragend", () => {
  state.draggingPath = null;
  clearDropTargets();
});

treeEl.addEventListener("dragenter", (e) => {
  if (!state.draggingPath) return;
  e.preventDefault();
});

treeEl.addEventListener("dragover", (e) => {
  const draggingPath = state.draggingPath;
  if (!draggingPath) return;
  const row = e.target.closest(".tree-item");
  if (row) {
    const targetType = row.dataset.type;
    if (targetType !== "dir" && targetType !== "file") return;
    clearDropTargets();
    row.classList.add("drop-target");
  }
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
});

treeEl.addEventListener("dragleave", (e) => {
  const row = e.target.closest(".tree-item");
  if (!row) return;
  row.classList.remove("drop-target");
});

treeEl.addEventListener("drop", async (e) => {
  const row = e.target.closest(".tree-item");
  e.preventDefault();
  clearDropTargets();
  const from = state.draggingPath;
  if (!from) return;

  let targetDir = "";
  if (row) {
    if (row.dataset.type !== "dir" && row.dataset.type !== "file") return;
    targetDir = row.dataset.type === "dir" ? row.dataset.path : parentDirOf(row.dataset.path);
  } else {
    targetDir = state.selectedDir || "";
  }

  const to = joinPath(normalizeDir(targetDir), basenameOf(from));
  if (to === from) {
    setStatus("No move.");
    return;
  }

  try {
    const ok = confirm(`Move\n\n${from}\n\n→ ${to}\n\nConfirm?`);
    if (!ok) return;
    setStatus("Moving…");
    await moveFilePath(from, to);
    invalidateFileIndex();
    const fromParent = parentDirOf(from);
    const toParent = parentDirOf(to);
    state.childrenByDir.delete(fromParent);
    state.childrenByDir.delete(toParent);
    await ensureDirLoaded(fromParent);
    if (toParent !== fromParent) await ensureDirLoaded(toParent);
    state.expandedDirs.add(toParent);

    if (state.activeFile === from) {
      state.activeFile = to;
      setActivePath(to);
      setDirty(false);
    }

    renderTree();
    setStatus("Moved.");
  } catch (err) {
    setStatus(`Error: ${err.message}`);
  } finally {
    state.draggingPath = null;
  }
});

editorEl.addEventListener("input", () => {
  if (!state.activeFile) return;
  setDirty(editorEl.value !== state.activeFileContent);
  if (state.dirty) scheduleAutosave();
});

editorEl.addEventListener("blur", () => {
  if (!state.activeFile) return;
  if (state.dirty) scheduleAutosave();
  showPreview();
});

previewEl.addEventListener("click", async (e) => {
  const a = e.target.closest("a");
  if (a) {
    const wl = a.dataset.wikilink;
    if (wl) {
      e.preventDefault();
      try {
        await openWikiLinkTarget(decodeURIComponent(wl));
      } catch (err) {
        setStatus(`Error: ${err.message}`);
      }
    }
    return;
  }
  showEditor({ focus: true });
});

saveBtn.addEventListener("click", async () => {
  try {
    await saveCurrent();
  } catch (err) {
    setStatus(`Error: ${err.message}`);
  }
});

document.addEventListener("keydown", async (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    try {
      await saveCurrent();
    } catch (err) {
      setStatus(`Error: ${err.message}`);
    }
  }
});

searchEl.addEventListener("input", () => {
  state.filter = searchEl.value;
  renderTree();
});

newFolderBtn.addEventListener("click", async () => {
  try {
    await createFolder();
  } catch (err) {
    setStatus(`Error: ${err.message}`);
  }
});

newFileBtn.addEventListener("click", async () => {
  try {
    await createFile();
  } catch (err) {
    setStatus(`Error: ${err.message}`);
  }
});

window.addEventListener("beforeunload", (e) => {
  if (!state.dirty) return;
  e.preventDefault();
  e.returnValue = "";
});

function resetUiState() {
  clearAutosaveTimer();
  invalidateFileIndex();
  state.expandedDirs = new Set([""]);
  state.childrenByDir = new Map();
  state.activeFile = null;
  state.activeFileContent = "";
  state.dirty = false;
  state.selectedDir = null;
  state.filter = searchEl.value || "";
  editorEl.value = "";
  previewEl.innerHTML = `<div class="muted">Select a file on the left…</div>`;
  previewEl.hidden = false;
  editorEl.hidden = true;
  setActivePath("");
  setDirty(false);
}

async function selectLocalVault() {
  if (!("showDirectoryPicker" in window)) {
    alert("Your browser does not support folder selection (File System Access API). Try Chrome/Edge/Brave.");
    return;
  }
  if (state.dirty) {
    const ok = confirm("You have unsaved changes. Continue without saving?");
    if (!ok) return;
  }
  setStatus("Selecting folder…");
  const handle = await window.showDirectoryPicker({ mode: "readwrite" });
  await vaultHandleStore.set(handle).catch(() => {});
  state.rootHandle = handle;
  state.vaultLabel = handle?.name ? `${handle.name} (local)` : "Local";
  setAppVersion(state.appVersion || getEmbeddedAppVersion() || (await tryGetPackageJsonVersion()));
  setMode("browser");
  vaultNameEl.textContent = state.vaultLabel ? `Vault: ${state.vaultLabel}` : "Vault: (local)";
  setVaultUiEnabled(true);
  resetUiState();
  await ensureDirLoaded("");
  renderTree();
  setStatus("Ready.");
}

async function switchToServerMode() {
  if (state.dirty) {
    const ok = confirm("You have unsaved changes. Continue without saving?");
    if (!ok) return;
  }
  setStatus("Disconnecting…");
  state.rootHandle = null;
  await vaultHandleStore.clear().catch(() => {});
  setMode("server");
  resetUiState();
  const cfg = await apiGet("/api/config").catch(() => null);
  state.appVersion = (cfg?.version || "").toString().trim() || state.appVersion;
  if (!state.appVersion) state.appVersion = getEmbeddedAppVersion() || (await tryGetPackageJsonVersion());
  setAppVersion(state.appVersion);
  vaultNameEl.textContent = cfg?.vault ? `Vault: ${cfg.vault}` : "";
  if (!cfg?.vault) {
    setVaultUiEnabled(false);
    treeEl.innerHTML = "";
    setStatus("Choose a local vault, or start the server with OBSIDIAN_VAULT/--vault.");
    showVaultModal();
    return;
  }
  setVaultUiEnabled(true);
  await ensureDirLoaded("");
  renderTree();
  setStatus("Ready.");
}

async function restoreLocalVaultFromStorage() {
  if (!("showDirectoryPicker" in window)) return false;
  const handle = await vaultHandleStore.get().catch(() => null);
  if (!handle) return false;

  const opts = { mode: "readwrite" };
  let perm = "prompt";
  if (typeof handle.queryPermission === "function") perm = await handle.queryPermission(opts);
  if (perm !== "granted" && typeof handle.requestPermission === "function") perm = await handle.requestPermission(opts);
  if (perm !== "granted") return false;

  state.rootHandle = handle;
  state.vaultLabel = handle?.name ? `${handle.name} (local)` : "Local";
  setAppVersion(state.appVersion || getEmbeddedAppVersion() || (await tryGetPackageJsonVersion()));
  setMode("browser");
  vaultNameEl.textContent = state.vaultLabel ? `Vault: ${state.vaultLabel}` : "Vault: (local)";
  setVaultUiEnabled(true);
  resetUiState();
  await ensureDirLoaded("");
  renderTree();
  setStatus("Ready.");
  if (vaultDialog?.open) vaultDialog.close();
  return true;
}

selectVaultBtn.addEventListener("click", async () => {
  try {
    if (state.mode === "demo") {
      demoVaultStore.clear();
      await openDemoVault();
      return;
    }
    if (state.mode === "dropbox") {
      if (!state.dropbox) throw new Error("Not connected to Dropbox");
      const rootPath = await showDropboxPathPicker({ initialPath: state.dropbox.rootPath || "" });
      if (rootPath === null) return;
      state.dropbox.rootPath = normalizeDropboxRootPath(rootPath);
      dropboxAuthStore.set(state.dropbox);
      state.vaultLabel = `Dropbox${state.dropbox.rootPath ? `: ${state.dropbox.rootPath}` : ""}`;
      vaultNameEl.textContent = `Vault: ${state.vaultLabel}`;
      resetUiState();
      await ensureDirLoaded("");
      renderTree();
      return;
    }
    await selectLocalVault();
  } catch (err) {
    setStatus(`Error: ${err.message}`);
  }
});

useServerBtn.addEventListener("click", async () => {
  try {
    if (state.mode === "dropbox") {
      state.dropbox = null;
      dropboxAuthStore.clear();
    }
    await switchToServerMode();
  } catch (err) {
    setStatus(`Error: ${err.message}`);
  }
});

async function bootstrap() {
  setStatus("Connecting to server…");
  const cfg = await apiGet("/api/config").catch(() => null);
  state.vaultLabel = cfg?.vault ? cfg.vault : "";
  vaultNameEl.textContent = state.vaultLabel ? `Vault: ${state.vaultLabel}` : "";
  state.appVersion = (cfg?.version || "").toString().trim() || state.appVersion;
  if (!state.appVersion) state.appVersion = getEmbeddedAppVersion() || (await tryGetPackageJsonVersion());
  setAppVersion(state.appVersion);
  setMode("server");

  const savedDropbox = dropboxAuthStore.get();
  if (savedDropbox && typeof savedDropbox === "object") {
    state.dropbox = savedDropbox;
  }

  const restored = await restoreLocalVaultFromStorage().catch(() => false);
  if (restored) return;

  if (!cfg?.vault) {
    setVaultUiEnabled(false);
    treeEl.innerHTML = "";
    setStatus("Choose a local vault, or start the server with OBSIDIAN_VAULT/--vault.");
    showVaultModal();
    return;
  }
  setVaultUiEnabled(true);
  await ensureDirLoaded("");
  renderTree();
  setStatus("Ready.");
}

try {
  const saved = localStorage.getItem("theme");
  applyTheme(saved === "light" ? "light" : "dark");
} catch {
  applyTheme("dark");
}

if (themeToggleEl) {
  themeToggleEl.addEventListener("change", () => applyTheme(themeToggleEl.checked ? "light" : "dark"));
}

if (vaultChooseBtn) {
  vaultChooseBtn.addEventListener("click", async () => {
    try {
      await selectLocalVault();
      if (vaultDialog?.open) vaultDialog.close();
    } catch (err) {
      setStatus(`Error: ${err.message}`);
    }
  });
}

if (vaultDemoBtn) {
  vaultDemoBtn.addEventListener("click", async () => {
    try {
      await openDemoVault();
    } catch (err) {
      setStatus(`Error: ${err.message}`);
    }
  });
}

if (vaultDropboxBtn) {
  vaultDropboxBtn.addEventListener("click", async () => {
    try {
      await openDropboxVault();
    } catch (err) {
      setStatus(`Error: ${err.message}`);
    }
  });
}

window.addEventListener("message", async (ev) => {
  if (ev.origin !== window.location.origin) return;
  const data = ev.data || {};
  if (data.type !== "dropbox-oauth") return;
  try {
    if (data.error) {
      setStatus(`Dropbox auth error: ${data.errorDescription || data.error}`);
      return;
    }
    const expectedState = sessionStorage.getItem("dropboxOauthState");
    const codeVerifier = sessionStorage.getItem("dropboxCodeVerifier");
    sessionStorage.removeItem("dropboxOauthState");
    sessionStorage.removeItem("dropboxCodeVerifier");
    if (!expectedState || !codeVerifier || data.state !== expectedState) {
      setStatus("Dropbox auth failed (state mismatch).");
      return;
    }
    const code = (data.code || "").toString();
    if (!code) {
      setStatus("Dropbox auth failed (missing code).");
      return;
    }

    setStatus("Connecting to Dropbox…");
    const cfg = await dropboxGetConfig();
    const redirectUri = cfg?.redirectUri || `${window.location.origin}/dropbox-oauth.html`;
    const exchanged = await dropboxExchangeCode({ code, codeVerifier, redirectUri });
    const accessToken = (exchanged?.accessToken || "").toString();
    const refreshToken = (exchanged?.refreshToken || "").toString();
    const expiresIn = Number(exchanged?.expiresIn || 0);
    const accountId = (exchanged?.accountId || "").toString();
    if (!accessToken || !refreshToken || !Number.isFinite(expiresIn)) {
      setStatus("Dropbox auth failed (invalid token response).");
      return;
    }

    if (vaultDialog?.open) vaultDialog.close();

    // Set a temporary session so we can validate the chosen Dropbox folder.
    state.dropbox = {
      accessToken,
      refreshToken,
      expiresAt: Date.now() + expiresIn * 1000,
      accountId,
      rootPath: ""
    };

    const chosenRoot = await showDropboxPathPicker({ initialPath: state.dropbox.rootPath || "" });
    if (chosenRoot === null) {
      setStatus("Canceled.");
      state.dropbox = null;
      dropboxAuthStore.clear();
      return;
    }
    state.dropbox.rootPath = normalizeDropboxRootPath(chosenRoot);

    dropboxAuthStore.set(state.dropbox);

    setMode("dropbox");
    state.vaultLabel = `Dropbox${state.dropbox.rootPath ? `: ${state.dropbox.rootPath}` : ""}`;
    vaultNameEl.textContent = `Vault: ${state.vaultLabel}`;
    setVaultUiEnabled(true);
    resetUiState();
    await ensureDirLoaded("");
    renderTree();
    setStatus("Ready.");
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    setStatus(`Dropbox connect failed: ${msg}`);
  }
});

bootstrap().catch((err) => setStatus(`Error: ${err.message}`));

document.addEventListener("click", () => hideContextMenu());
window.addEventListener("blur", () => hideContextMenu());
window.addEventListener("scroll", () => hideContextMenu(), true);

treeEl.addEventListener("contextmenu", (e) => {
  const row = e.target.closest(".tree-item");
  if (!row) return;
  if (row.dataset.type !== "file") return;
  e.preventDefault();
  showContextMenu({ x: e.clientX, y: e.clientY, path: row.dataset.path });
});

if (contextDeleteFileEl) {
  contextDeleteFileEl.addEventListener("click", async (e) => {
    e.preventDefault();
    const p = contextMenuEl?.dataset?.path;
    hideContextMenu();
    if (!p) return;
    const ok = confirm(`Delete\n\n${p}\n\nThis cannot be undone. Continue?`);
    if (!ok) return;
    try {
      setStatus("Deleting…");
      await deleteFilePath(p);
      invalidateFileIndex();
      const parent = parentDirOf(p);
      state.childrenByDir.delete(parent);
      await ensureDirLoaded(parent);

      if (state.activeFile === p) {
        state.activeFile = null;
        state.activeFileContent = "";
        editorEl.value = "";
        showPreview();
        setActivePath("");
        setDirty(false);
      }

      renderTree();
      setStatus("Deleted.");
    } catch (err) {
      setStatus(`Error: ${err.message}`);
    }
  });
}
