module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify({ error: "Method Not Allowed" }));
    return;
  }

  const appKey = (process.env.DROPBOX_APP_KEY || "").toString().trim();
  const appSecret = (process.env.DROPBOX_APP_SECRET || "").toString().trim();
  if (!appKey || !appSecret) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify({ error: "Dropbox not configured" }));
    return;
  }

  let payload = {};
  try {
    payload = JSON.parse(req.body || "{}");
  } catch {}

  const refreshToken = payload.refreshToken;
  if (!refreshToken) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify({ error: "Expected { refreshToken }" }));
    return;
  }

  const params = new URLSearchParams();
  params.set("grant_type", "refresh_token");
  params.set("refresh_token", refreshToken);
  params.set("client_id", appKey);
  params.set("client_secret", appSecret);

  const r = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString()
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify({ error: data?.error_description || data?.error || "OAuth refresh failed" }));
    return;
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify({ accessToken: data.access_token, expiresIn: data.expires_in, accountId: data.account_id }));
};

