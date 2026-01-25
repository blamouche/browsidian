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

const state = {
  mode: "server", // "server" | "browser"
  vaultLabel: "",
  rootHandle: null,
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

function getEmbeddedAppVersion() {
  const meta = document.querySelector('meta[name="app-version"]');
  const v = (meta?.getAttribute("content") || "").trim();
  if (!v || v === "__APP_VERSION__") return null;
  return v;
}

function setAppVersion(version) {
  if (!appVersionEl) return;
  const v = (version || "").toString().trim();
  appVersionEl.textContent = v ? `v${v}` : "v—";
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
    html += `<p>${inline(buf.join(" "))}</p>`;
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
  previewEl.innerHTML = state.activeFile
    ? renderMarkdownBasic(content)
    : `<div class="muted">Select a file on the left…</div>`;
}

function showEditor({ focus } = { focus: true }) {
  if (!state.activeFile) return;
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
  selectVaultBtn.textContent = nextMode === "browser" ? "Change local vault" : "Choose local vault";
  useServerBtn.hidden = nextMode !== "browser";
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

async function readFileBrowser(fileRel) {
  const handle = await getFileHandleByPath(fileRel, { create: false });
  const file = await handle.getFile();
  return await file.text();
}

async function writeFileBrowser(fileRel, content) {
  const handle = await getFileHandleByPath(fileRel, { create: true });
  const writable = await handle.createWritable();
  await writable.write(content);
  await writable.close();
}

async function mkdirBrowser(dirRel) {
  await getDirHandleByPath(dirRel, { create: true });
}

async function listDir(dirRel) {
  const d = normalizeDir(dirRel);
  if (state.mode === "browser") return await listDirBrowser(d);
  const data = await apiGet(`/api/list?dir=${encodeURIComponent(d)}`);
  return data.entries;
}

async function readFile(rel) {
  if (state.mode === "browser") return await readFileBrowser(rel);
  const data = await apiGet(`/api/read?path=${encodeURIComponent(rel)}`);
  return data.content;
}

async function writeFile(rel, content) {
  if (state.mode === "browser") return await writeFileBrowser(rel, content);
  await apiSend("PUT", "/api/write", { path: rel, content });
}

async function mkdir(rel) {
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
  if (state.mode === "browser") {
    await deleteFileBrowser(fileRel);
    return;
  }
  await apiSend("POST", "/api/delete", { path: fileRel });
}

async function moveFilePath(fromRel, toRel) {
  if (fromRel === toRel) return;
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
  if (entry.type === "dir") return state.expandedDirs.has(entry.path) ? "▼" : "▶";
  return "•";
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

      const icon = document.createElement("div");
      icon.className = "icon";
      icon.textContent = iconFor(entry);

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
  promptInput.select();
  return new Promise((resolve) => {
    promptDialog.addEventListener(
      "close",
      () => {
        const ok = promptDialog.returnValue === "ok";
        resolve(ok ? promptInput.value : null);
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

async function createFolder() {
  const base = state.activeFile ? parentDirOf(state.activeFile) : "";
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
  const base = state.activeFile ? parentDirOf(state.activeFile) : "";
  const rel = await showPrompt({
    title: "New file",
    label: "Path (relative to the vault)",
    help: "Example: Notes/my-note.md",
    placeholder: base ? `${base}/new.md` : "new.md",
    value: base ? `${base}/` : ""
  });
  if (!rel) return;
  if (!rel.toLowerCase().endsWith(".md")) {
    const ok = confirm("The file does not end with .md. Continue?");
    if (!ok) return;
  }
  setStatus("Creating file…");
  await writeFile(rel, "");
  invalidateFileIndex();
  const parent = parentDirOf(rel);
  state.childrenByDir.delete(parent);
  await ensureDirLoaded(parent);
  state.expandedDirs.add(parent);
  setStatus("File created.");
  renderTree();
  await openFile(rel);
}

treeEl.addEventListener("click", async (e) => {
  const row = e.target.closest(".tree-item");
  if (!row) return;
  const type = row.dataset.type;
  const p = row.dataset.path;
  try {
    if (type === "dir") await toggleDir(p);
    else await openFile(p);
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
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", row.dataset.path);
  e.dataTransfer.setData("application/x-obsidian-web-path", row.dataset.path);
});

treeEl.addEventListener("dragend", () => {
  state.draggingPath = null;
  clearDropTargets();
});

treeEl.addEventListener("dragover", (e) => {
  const row = e.target.closest(".tree-item");
  if (!row) return;
  const draggingPath = state.draggingPath;
  if (!draggingPath) return;
  const targetType = row.dataset.type;
  if (targetType !== "dir" && targetType !== "file") return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
  clearDropTargets();
  row.classList.add("drop-target");
});

treeEl.addEventListener("dragleave", (e) => {
  const row = e.target.closest(".tree-item");
  if (!row) return;
  row.classList.remove("drop-target");
});

treeEl.addEventListener("drop", async (e) => {
  const row = e.target.closest(".tree-item");
  if (!row) return;
  e.preventDefault();
  clearDropTargets();
  const from = state.draggingPath;
  if (!from) return;
  if (row.dataset.type !== "dir" && row.dataset.type !== "file") return;

  const targetDir = row.dataset.type === "dir" ? row.dataset.path : parentDirOf(row.dataset.path);
  const to = joinPath(normalizeDir(targetDir), basenameOf(from));
  if (to === from) return;

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
  setAppVersion(getEmbeddedAppVersion());
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
  setAppVersion(cfg?.version || getEmbeddedAppVersion());
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
  setAppVersion(getEmbeddedAppVersion());
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
    await selectLocalVault();
  } catch (err) {
    setStatus(`Error: ${err.message}`);
  }
});

useServerBtn.addEventListener("click", async () => {
  try {
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
  setAppVersion(cfg?.version || getEmbeddedAppVersion());
  setMode("server");

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
