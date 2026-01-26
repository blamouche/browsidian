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

  const code = payload.code;
  const codeVerifier = payload.codeVerifier;
  const redirectUri = payload.redirectUri;
  if (!code || !codeVerifier || !redirectUri) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify({ error: "Expected { code, codeVerifier, redirectUri }" }));
    return;
  }

  const params = new URLSearchParams();
  params.set("grant_type", "authorization_code");
  params.set("code", code);
  params.set("client_id", appKey);
  params.set("client_secret", appSecret);
  params.set("code_verifier", codeVerifier);
  params.set("redirect_uri", redirectUri);

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
    res.end(JSON.stringify({ error: data?.error_description || data?.error || "OAuth exchange failed" }));
    return;
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(
    JSON.stringify({
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in,
      accountId: data.account_id
    })
  );
};

