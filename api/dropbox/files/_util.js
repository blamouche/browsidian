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

function getPayload(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body || "{}");
    } catch {
      return {};
    }
  }
  return {};
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
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error_summary || `Dropbox HTTP ${r.status}`);
  return data;
}

async function downloadText({ token, dropboxPath }) {
  const r = await fetch("https://content.dropboxapi.com/2/files/download", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Dropbox-API-Arg": JSON.stringify({ path: dropboxPath }) }
  });
  if (!r.ok) throw new Error(`Dropbox HTTP ${r.status}`);
  return await r.text();
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
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error_summary || `Dropbox HTTP ${r.status}`);
  return data;
}

module.exports = { json, getToken, getPayload, callJson, downloadText, uploadText };

