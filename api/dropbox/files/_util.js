function json(res, status, data) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(data));
}

function getToken(req) {
  const token = (req.headers["x-dropbox-access-token"] || "").toString().trim();
  return token || null;
}

async function getPayload(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body || "{}");
    } catch {
      return {};
    }
  }

  // Fallback for runtimes that don't populate req.body.
  const raw = await new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 2 * 1024 * 1024) req.destroy();
    });
    req.on("end", () => resolve(body));
    req.on("error", () => resolve(""));
  });
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function callJson({ token, path, payload }) {
  const r = await fetch(`https://api.dropboxapi.com/2/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify(payload)
  });
  const raw = await r.text().catch(() => "");
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {}
  if (!r.ok) {
    const msg = data?.error_summary || data?.error || raw || `Dropbox HTTP ${r.status}`;
    const err = new Error(msg);
    err.dropboxStatus = r.status;
    err.dropboxBody = raw;
    throw err;
  }
  return data;
}

async function downloadText({ token, dropboxPath }) {
  const r = await fetch("https://content.dropboxapi.com/2/files/download", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Dropbox-API-Arg": JSON.stringify({ path: dropboxPath }) }
  });
  const raw = await r.text().catch(() => "");
  if (!r.ok) {
    const err = new Error(raw || `Dropbox HTTP ${r.status}`);
    err.dropboxStatus = r.status;
    err.dropboxBody = raw;
    throw err;
  }
  return raw;
}

async function uploadText({ token, dropboxPath, content }) {
  const r = await fetch("https://content.dropboxapi.com/2/files/upload", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/octet-stream",
      "Dropbox-API-Arg": JSON.stringify({ path: dropboxPath, mode: "overwrite", autorename: false, mute: true })
    },
    body: (content ?? "").toString()
  });
  const raw = await r.text().catch(() => "");
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {}
  if (!r.ok) {
    const msg = data?.error_summary || data?.error || raw || `Dropbox HTTP ${r.status}`;
    const err = new Error(msg);
    err.dropboxStatus = r.status;
    err.dropboxBody = raw;
    throw err;
  }
  return data;
}

module.exports = { json, getToken, getPayload, callJson, downloadText, uploadText };
