const http = require("http");
const fsp = require("fs/promises");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const DEFAULT_PORT = 5173;
const STATIC_DIR = path.join(__dirname, "public");
const IGNORED_DIRS = new Set([".obsidian", ".git", "node_modules", ".trash", ".DS_Store"]);

async function getAppVersion() {
  try {
    const pkg = JSON.parse(await fsp.readFile(path.join(__dirname, "package.json"), "utf8"));
    return pkg && typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === "--vault") args.vault = argv[++i];
    else if (item === "--port") args.port = Number(argv[++i]);
    else if (item === "--host") args.host = argv[++i];
  }
  return args;
}

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function text(res, status, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });
  res.end(body);
}

async function readBody(req, limitBytes = 5 * 1024 * 1024) {
  return await new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(Object.assign(new Error("Payload too large"), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function safeRelPath(input) {
  const rel = (input ?? "").toString();
  if (rel.includes("\0")) throw Object.assign(new Error("Invalid path"), { statusCode: 400 });
  return rel.replaceAll("\\", "/");
}

function ensureInsideVault(vaultReal, relPath) {
  const rel = safeRelPath(relPath);
  const abs = path.resolve(vaultReal, rel);
  const vaultPrefix = vaultReal.endsWith(path.sep) ? vaultReal : vaultReal + path.sep;
  if (abs === vaultReal) return abs;
  if (!abs.startsWith(vaultPrefix)) throw Object.assign(new Error("Path escapes vault"), { statusCode: 400 });
  return abs;
}

function shouldIgnoreName(name) {
  if (!name) return true;
  if (name === ".DS_Store") return true;
  return IGNORED_DIRS.has(name);
}

async function listDir(vaultReal, dirRel) {
  const absDir = ensureInsideVault(vaultReal, dirRel);
  const entries = await fsp.readdir(absDir, { withFileTypes: true });
  const mapped = [];
  for (const ent of entries) {
    if (shouldIgnoreName(ent.name)) continue;
    const entRel = path.posix.join(safeRelPath(dirRel || "").replaceAll(/\/+$/g, ""), ent.name);
    if (ent.isDirectory()) {
      mapped.push({ name: ent.name, path: entRel, type: "dir" });
      continue;
    }
    if (ent.isFile()) {
      mapped.push({ name: ent.name, path: entRel, type: "file" });
    }
  }
  mapped.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
  return mapped;
}

async function readFileUtf8(vaultReal, fileRel) {
  const abs = ensureInsideVault(vaultReal, fileRel);
  const st = await fsp.stat(abs);
  if (!st.isFile()) throw Object.assign(new Error("Not a file"), { statusCode: 400 });
  return await fsp.readFile(abs, "utf8");
}

async function writeFileUtf8(vaultReal, fileRel, content) {
  const abs = ensureInsideVault(vaultReal, fileRel);
  const dir = path.dirname(abs);
  const dirSt = await fsp.stat(dir);
  if (!dirSt.isDirectory()) throw Object.assign(new Error("Parent is not a directory"), { statusCode: 400 });
  await fsp.writeFile(abs, content, "utf8");
}

async function moveFile(vaultReal, fromRel, toRel) {
  const fromAbs = ensureInsideVault(vaultReal, fromRel);
  const toAbs = ensureInsideVault(vaultReal, toRel);
  const fromSt = await fsp.stat(fromAbs);
  if (!fromSt.isFile()) throw Object.assign(new Error("Source is not a file"), { statusCode: 400 });
  const toDir = path.dirname(toAbs);
  const toDirSt = await fsp.stat(toDir).catch(() => null);
  if (!toDirSt || !toDirSt.isDirectory()) throw Object.assign(new Error("Destination directory not found"), { statusCode: 400 });
  const existing = await fsp.stat(toAbs).catch(() => null);
  if (existing) throw Object.assign(new Error("Destination already exists"), { statusCode: 409 });
  await fsp.rename(fromAbs, toAbs);
}

async function deleteFile(vaultReal, fileRel) {
  const abs = ensureInsideVault(vaultReal, fileRel);
  const st = await fsp.stat(abs);
  if (!st.isFile()) throw Object.assign(new Error("Not a file"), { statusCode: 400 });
  await fsp.unlink(abs);
}

async function mkdirp(vaultReal, dirRel) {
  const abs = ensureInsideVault(vaultReal, dirRel);
  await fsp.mkdir(abs, { recursive: true });
}

function guessContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".js") return "application/javascript; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".ico") return "image/x-icon";
  return "application/octet-stream";
}

async function serveStatic(reqUrl, res) {
  let pathname = reqUrl.pathname;
  if (pathname === "/") pathname = "/index.html";
  const abs = path.resolve(STATIC_DIR, "." + pathname);
  const staticPrefix = STATIC_DIR.endsWith(path.sep) ? STATIC_DIR : STATIC_DIR + path.sep;
  if (!abs.startsWith(staticPrefix)) return false;
  try {
    const st = await fsp.stat(abs);
    if (!st.isFile()) return false;
    if (pathname === "/index.html") {
      const version = await getAppVersion();
      const raw = await fsp.readFile(abs, "utf8");
      let body = raw.replaceAll("__APP_VERSION__", version);
      body = body.replace(
        /<meta\s+name="app-version"\s+content="[^"]*"\s*\/?>/i,
        `<meta name="app-version" content="${version}" />`
      );
      body = body.replace(
        /<span\s+id="appVersion"([^>]*)>[^<]*<\/span>/i,
        `<span id="appVersion"$1>v${version}</span>`
      );
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
        "Cache-Control": "no-store"
      });
      res.end(body);
      return true;
    }

    res.writeHead(200, {
      "Content-Type": guessContentType(abs),
      "Content-Length": st.size,
      "Cache-Control": "no-store"
    });
    fs.createReadStream(abs).pipe(res);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const vault = args.vault ?? process.env.OBSIDIAN_VAULT;
  const vaultReal = vault ? await fsp.realpath(vault) : null;
  const port = Number.isFinite(args.port) ? args.port : Number(process.env.PORT || DEFAULT_PORT);
  const host = args.host ?? process.env.HOST ?? "127.0.0.1";

  const server = http.createServer(async (req, res) => {
    try {
      if (!req.url) return text(res, 400, "Bad Request");
      const reqUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);

      if (reqUrl.pathname.startsWith("/api/")) {
        if (req.method === "GET" && reqUrl.pathname === "/api/health") {
          return json(res, 200, { ok: true });
        }

        if (req.method === "GET" && reqUrl.pathname === "/api/config") {
          const version = await getAppVersion();
          return json(res, 200, { vault: vaultReal ? path.basename(vaultReal) : null, version });
        }

        if (!vaultReal) {
          return json(res, 400, {
            error:
              "No vault configured. Start the server with --vault /path/to/vault, or use 'Choose local vault' in the UI."
          });
        }

        if (req.method === "GET" && reqUrl.pathname === "/api/list") {
          const dir = reqUrl.searchParams.get("dir") || "";
          const entries = await listDir(vaultReal, dir);
          return json(res, 200, { dir, entries });
        }

        if (req.method === "GET" && reqUrl.pathname === "/api/read") {
          const filePath = reqUrl.searchParams.get("path");
          if (!filePath) return json(res, 400, { error: "Missing path" });
          const content = await readFileUtf8(vaultReal, filePath);
          return json(res, 200, { path: filePath, content });
        }

        if (req.method === "PUT" && reqUrl.pathname === "/api/write") {
          const bodyBuf = await readBody(req);
          let payload;
          try {
            payload = JSON.parse(bodyBuf.toString("utf8") || "{}");
          } catch {
            return json(res, 400, { error: "Invalid JSON" });
          }
          if (!payload || typeof payload.path !== "string" || typeof payload.content !== "string") {
            return json(res, 400, { error: "Expected { path, content }" });
          }
          await writeFileUtf8(vaultReal, payload.path, payload.content);
          return json(res, 200, { ok: true });
        }

        if (req.method === "POST" && reqUrl.pathname === "/api/move") {
          const bodyBuf = await readBody(req, 1024 * 1024);
          let payload;
          try {
            payload = JSON.parse(bodyBuf.toString("utf8") || "{}");
          } catch {
            return json(res, 400, { error: "Invalid JSON" });
          }
          if (!payload || typeof payload.from !== "string" || typeof payload.to !== "string") {
            return json(res, 400, { error: "Expected { from, to }" });
          }
          await moveFile(vaultReal, payload.from, payload.to);
          return json(res, 200, { ok: true });
        }

        if (req.method === "POST" && reqUrl.pathname === "/api/delete") {
          const bodyBuf = await readBody(req, 1024 * 1024);
          let payload;
          try {
            payload = JSON.parse(bodyBuf.toString("utf8") || "{}");
          } catch {
            return json(res, 400, { error: "Invalid JSON" });
          }
          if (!payload || typeof payload.path !== "string") {
            return json(res, 400, { error: "Expected { path }" });
          }
          await deleteFile(vaultReal, payload.path);
          return json(res, 200, { ok: true });
        }

        if (req.method === "POST" && reqUrl.pathname === "/api/mkdir") {
          const bodyBuf = await readBody(req, 1024 * 1024);
          let payload;
          try {
            payload = JSON.parse(bodyBuf.toString("utf8") || "{}");
          } catch {
            return json(res, 400, { error: "Invalid JSON" });
          }
          if (!payload || typeof payload.path !== "string") return json(res, 400, { error: "Expected { path }" });
          await mkdirp(vaultReal, payload.path);
          return json(res, 200, { ok: true });
        }

        return json(res, 404, { error: "Not found" });
      }

      const served = await serveStatic(reqUrl, res);
      if (!served) text(res, 404, "Not Found");
    } catch (err) {
      const statusCode = err && typeof err.statusCode === "number" ? err.statusCode : 500;
      const message = err && err.message ? err.message : "Internal Server Error";
      json(res, statusCode, { error: message });
    }
  });

  server.listen(port, host, () => {
    console.log(`Vault: ${vaultReal ?? "(none)"}`);
    console.log(`Server: http://${host}:${port}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
